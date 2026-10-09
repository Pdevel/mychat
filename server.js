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

// Czat głosowy (WebRTC peer-to-peer). Każdy łączy się z każdym, więc liczba osób jest ograniczona.
const MAX_VOICE_USERS = 8;
// Serwer STUN jest darmowy. Za zaporami sieciowymi bywa potrzebny też serwer TURN (zmienne TURN_URL,
// TURN_USERNAME, TURN_CREDENTIAL) – patrz instrukcja.
const ICE_SERVERS = [{ urls: process.env.STUN_URL || 'stun:stun.l.google.com:19302' }];
if (process.env.TURN_URL) {
  ICE_SERVERS.push({
    urls: process.env.TURN_URL.split(',').map((u) => u.trim()),
    username: process.env.TURN_USERNAME || '',
    credential: process.env.TURN_CREDENTIAL || '',
  });
}

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
    iceServers: ICE_SERVERS,
    maxVoiceUsers: MAX_VOICE_USERS,
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

// ---------- Konta ----------
// Każde urządzenie (przeglądarka) ma własne, stałe konto. Klient generuje tajny token i trzyma go
// w localStorage; serwer zapisuje tylko jego skrót SHA-256. Nick jest zarezerwowany dla konta.
const MAX_ACCOUNTS = 5000;
const ACCOUNTS_PER_IP_PER_HOUR = 5;
const accountsById = new Map(); // id -> { id, nick, avatar, tokenHash, createdAt }
const accountsByToken = new Map(); // tokenHash -> konto
const accountsByNick = new Map(); // nick małymi literami -> konto
const registrations = new Map(); // ip -> [znaczniki czasu]

function indexAccount(account) {
  accountsById.set(account.id, account);
  accountsByToken.set(account.tokenHash, account);
  accountsByNick.set(account.nick.toLowerCase(), account);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function clientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  return (typeof forwarded === 'string' && forwarded.split(',')[0].trim()) || socket.handshake.address;
}

function registrationLimited(ip) {
  const now = Date.now();
  const recent = (registrations.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= ACCOUNTS_PER_IP_PER_HOUR) {
    registrations.set(ip, recent);
    return true;
  }
  recent.push(now);
  registrations.set(ip, recent);
  return false;
}

async function persistAccount(account) {
  try {
    await store.saveAccount(account);
  } catch (err) {
    console.error('Nie udało się zapisać konta:', err.message);
  }
}

// socket.id -> { accountId, nick } (aktywne połączenia; jedno konto może mieć kilka kart)
const users = new Map();

function isOnline(accountId) {
  for (const u of users.values()) if (u.accountId === accountId) return true;
  return false;
}
// socket.id -> { muted, deafened } (osoby na kanale głosowym)
const voice = new Map();

function voiceList() {
  return Array.from(voice.entries())
    .filter(([id]) => users.has(id))
    .map(([id, s]) => ({ id, nick: users.get(id).nick, muted: s.muted, deafened: s.deafened }));
}

function broadcastVoice() {
  io.emit('voice:users', voiceList());
}

function leaveVoice(socket) {
  if (voice.delete(socket.id)) broadcastVoice();
}

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

// Zamienia link do STRONY z GIFem (Tenor, Giphy) na bezpośredni adres obrazka.
// Zwykłe linki do obrazków (.gif/.png/.jpg/.webp) przechodzą bez zmian. Zwraca null, gdy się nie da.
const resolvedLinks = new Map();

async function resolveGifLink(raw) {
  if (typeof raw !== 'string' || raw.length > 600) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();

  // Bezpośredni link do obrazka
  if (/\.(gif|png|jpe?g|webp)$/i.test(u.pathname)) return u.href;

  // Giphy: https://giphy.com/gifs/nazwa-ID  ->  https://media.giphy.com/media/ID/giphy.gif
  if (host === 'giphy.com' || host === 'www.giphy.com') {
    const m = u.pathname.match(/^\/gifs\/(?:[^/]*-)?([A-Za-z0-9]+)\/?$/);
    return m ? `https://media.giphy.com/media/${m[1]}/giphy.gif` : null;
  }

  // Tenor: https://tenor.com/view/...  (także z prefiksem języka, np. /pl/view/...)
  if (host === 'tenor.com' || host === 'www.tenor.com') {
    if (!/^\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?view\/[^/]+\/?$/.test(u.pathname)) return null;

    const cached = resolvedLinks.get(u.href);
    if (cached && Date.now() - cached.time < 60 * 60 * 1000) return cached.url;

    try {
      // Pobieramy wyłącznie stronę z tenor.com; adres obrazka czytamy z metadanych Open Graph.
      const res = await fetch(u.href, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MyChatBot/1.0)', Accept: 'text/html' },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok || !new URL(res.url).hostname.endsWith('tenor.com')) return null;
      const html = await res.text();
      const m = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
      if (!m) return null;
      const image = new URL(m[1]);
      if (image.protocol !== 'https:' || !image.hostname.endsWith('.tenor.com')) return null;
      if (!/\.(gif|png|jpe?g|webp)$/i.test(image.pathname)) return null;

      if (resolvedLinks.size > 200) resolvedLinks.clear();
      resolvedLinks.set(u.href, { time: Date.now(), url: image.href });
      return image.href;
    } catch (err) {
      console.error('Nie udało się odczytać linku Tenor:', err.message);
      return null;
    }
  }

  return null;
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
  const online = new Map(); // jedna pozycja na konto, nawet gdy otwarto kilka kart
  for (const { accountId } of users.values()) {
    const account = accountsById.get(accountId);
    if (account) online.set(accountId, { nick: account.nick, avatar: account.avatar });
  }
  io.emit('users', Array.from(online.values()));
}

function systemMessage(text) {
  io.emit('system', { text, time: Date.now() });
}

// ---------- Kanały tekstowe ----------
// Każdy kanał ma osobną historię. Pełne wiadomości dostają tylko osoby, które oglądają dany kanał
// (pokój `ch:<id>`); reszta dostaje lekkie powiadomienie `activity` (kropka przy kanale).
// Kanał nsfw jest dostępny dopiero po potwierdzeniu pełnoletności (pokój `adult`).
const CHANNELS = [
  { id: 'ogolny', name: 'ogólny' },
  { id: 'ogolny2', name: 'ogólny2' },
  { id: 'screeny', name: 'screeny' },
  { id: 'granie', name: 'granie' },
  { id: 'nsfw', name: 'nsfw', nsfw: true },
];
const CHANNELS_BY_ID = new Map(CHANNELS.map((c) => [c.id, c]));
const DEFAULT_CHANNEL = 'ogolny';

// Przenosi połączenie do kanału (opuszcza poprzedni pokój, wchodzi do nowego).
function enterChannel(socket, channelId) {
  if (socket.data.channel) socket.leave(`ch:${socket.data.channel}`);
  socket.data.channel = channelId;
  socket.join(`ch:${channelId}`);
}

async function sendHistory(socket, channelId) {
  let messages = [];
  try {
    // Pliki bez zawartości – pobierane na żądanie przez 'getFile'.
    messages = await store.recent(Date.now() - RETENTION_MS, HISTORY_LIMIT, channelId);
  } catch (err) {
    console.error('Nie udało się wczytać historii:', err.message);
  }
  socket.emit('history', { channel: channelId, messages });
}

async function emitMessage(socket, nick, extra) {
  const channel = socket.data.channel || DEFAULT_CHANNEL;
  const msg = {
    id: crypto.randomUUID(),
    senderId: socket.id,
    accountId: users.get(socket.id)?.accountId, // pozwala autorowi usunąć własną wiadomość
    channel,
    nick,
    time: Date.now(),
    ...extra,
  };
  io.to(`ch:${channel}`).emit('message', msg);
  io.to(CHANNELS_BY_ID.get(channel)?.nsfw ? 'adult' : 'lobby')
    .except(`ch:${channel}`)
    .emit('activity', { channel });
  try {
    await store.add(msg);
  } catch (err) {
    console.error('Nie udało się zapisać wiadomości:', err.message);
  }
}

io.on('connection', (socket) => {
  socket.on('join', async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!payload || typeof payload !== 'object') return reply({ ok: false, error: 'Nieprawidłowe dane.' });

    const token = payload.token;
    if (typeof token !== 'string' || token.length < 32 || token.length > 128) {
      return reply({ ok: false, error: 'Brak identyfikatora urządzenia.' });
    }

    let account = accountsByToken.get(hashToken(token));
    if (!account) {
      // Nowe urządzenie – tworzymy konto z wybranym nickiem (nick musi być unikalny).
      const nick = cleanText(payload.nick, MAX_NICK_LENGTH);
      if (!nick) return reply({ ok: false, needNick: true, error: 'Podaj nick.' });
      if (accountsByNick.has(nick.toLowerCase())) {
        return reply({ ok: false, needNick: true, error: 'Ten nick jest już zajęty.' });
      }
      if (accountsById.size >= MAX_ACCOUNTS) {
        return reply({ ok: false, needNick: true, error: 'Serwer osiągnął limit kont.' });
      }
      if (registrationLimited(clientIp(socket))) {
        return reply({ ok: false, needNick: true, error: 'Zbyt wiele nowych kont z tego adresu. Spróbuj później.' });
      }
      account = {
        id: crypto.randomUUID(),
        nick,
        avatar: validAvatar(payload.avatar) ? payload.avatar : null,
        tokenHash: hashToken(token),
        createdAt: Date.now(),
      };
      indexAccount(account); // od razu, żeby nikt nie zajął nicka w trakcie zapisu
      await persistAccount(account);
    }

    const nick = account.nick;
    const alreadyIn = users.has(socket.id);
    const firstSession = !isOnline(account.id);
    users.set(socket.id, { accountId: account.id, nick });

    // Kanał, w którym klient był ostatnio (kanał nsfw tylko po potwierdzeniu pełnoletności).
    socket.data.adult = payload.adult === true;
    let channel = CHANNELS_BY_ID.has(payload.channel) ? payload.channel : DEFAULT_CHANNEL;
    if (CHANNELS_BY_ID.get(channel).nsfw && !socket.data.adult) channel = DEFAULT_CHANNEL;
    socket.join('lobby');
    if (socket.data.adult) socket.join('adult');
    enterChannel(socket, channel);

    reply({
      ok: true,
      nick,
      avatar: account.avatar,
      id: socket.id,
      accountId: account.id,
      channel,
      channels: CHANNELS,
    });

    if (!alreadyIn) {
      await sendHistory(socket, channel);
      socket.emit('voice:users', voiceList());
      if (firstSession) systemMessage(`${nick} dołączył(a) do czatu`);
    }
    broadcastUsers();
  });

  socket.on('switchChannel', async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const user = users.get(socket.id);
    if (!user) return reply({ ok: false, error: 'Najpierw dołącz do czatu.' });
    const channel = payload && CHANNELS_BY_ID.get(payload.channel);
    if (!channel) return reply({ ok: false, error: 'Nie ma takiego kanału.' });
    if (rateLimited(socket, 'switch', 20, 10000)) {
      return reply({ ok: false, error: 'Zwolnij trochę – za szybko zmieniasz kanały.' });
    }
    if (channel.nsfw && !socket.data.adult) {
      if (payload.adult !== true) {
        return reply({ ok: false, needAdult: true, error: 'Ten kanał jest tylko dla osób pełnoletnich.' });
      }
      socket.data.adult = true;
      socket.join('adult');
    }

    const previous = socket.data.channel;
    if (previous) socket.to(`ch:${previous}`).emit('typing', { nick: user.nick, isTyping: false, channel: previous });
    enterChannel(socket, channel.id);
    reply({ ok: true, channel: channel.id });
    await sendHistory(socket, channel.id);
  });

  socket.on('rename', async (rawNick, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const user = users.get(socket.id);
    const account = user && accountsById.get(user.accountId);
    if (!account) return reply({ ok: false, error: 'Najpierw dołącz do czatu.' });

    const nick = cleanText(rawNick, MAX_NICK_LENGTH);
    if (!nick) return reply({ ok: false, error: 'Podaj nick.' });
    if (nick === account.nick) return reply({ ok: true, nick });
    const owner = accountsByNick.get(nick.toLowerCase());
    if (owner && owner.id !== account.id) return reply({ ok: false, error: 'Ten nick jest już zajęty.' });
    if (rateLimited(socket, 'rename', 3, 60 * 60 * 1000)) {
      return reply({ ok: false, error: 'Nick można zmieniać maksymalnie 3 razy na godzinę.' });
    }

    const oldNick = account.nick;
    accountsByNick.delete(oldNick.toLowerCase());
    account.nick = nick;
    accountsByNick.set(nick.toLowerCase(), account);
    for (const u of users.values()) if (u.accountId === account.id) u.nick = nick;
    await persistAccount(account);

    reply({ ok: true, nick });
    systemMessage(`${oldNick} zmienił(a) nick na ${nick}`);
    broadcastUsers();
    if (voice.size) broadcastVoice();
  });

  // ---------- Czat głosowy: serwer tylko pośredniczy w wymianie sygnałów WebRTC ----------
  socket.on('voice:join', (ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!users.has(socket.id)) return reply({ ok: false, error: 'Najpierw dołącz do czatu.' });
    if (!voice.has(socket.id) && voice.size >= MAX_VOICE_USERS) {
      return reply({ ok: false, error: `Kanał głosowy jest pełny (maksymalnie ${MAX_VOICE_USERS} osób).` });
    }
    // Osoba dołączająca sama zainicjuje połączenia z tymi, którzy już są na kanale.
    const peers = Array.from(voice.keys()).filter((id) => id !== socket.id && users.has(id));
    voice.set(socket.id, { muted: false, deafened: false });
    reply({ ok: true, peers });
    broadcastVoice();
  });

  socket.on('voice:leave', () => leaveVoice(socket));

  socket.on('voice:state', (state) => {
    const entry = voice.get(socket.id);
    if (!entry || !state) return;
    entry.muted = Boolean(state.muted);
    entry.deafened = Boolean(state.deafened);
    broadcastVoice();
  });

  socket.on('voice:signal', (payload) => {
    if (!voice.has(socket.id) || !payload) return;
    const { to, data } = payload;
    if (typeof to !== 'string' || !voice.has(to) || to === socket.id) return;
    if (!data || typeof data !== 'object' || JSON.stringify(data).length > 20000) return;
    if (rateLimited(socket, 'signal', 300, 10000)) return;
    io.to(to).emit('voice:signal', { from: socket.id, data });
  });

  // Usuwanie wiadomości: tylko autor może usunąć własną wiadomość (znika u wszystkich i z serwera).
  socket.on('deleteMessage', async (id, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const user = users.get(socket.id);
    if (!user) return reply({ ok: false, error: 'Najpierw dołącz do czatu.' });
    if (typeof id !== 'string' || id.length > 64) return reply({ ok: false, error: 'Nieprawidłowa wiadomość.' });
    if (rateLimited(socket, 'delete', 20, 10000)) {
      return reply({ ok: false, error: 'Zwolnij trochę – za dużo usunięć naraz.' });
    }
    try {
      const msg = await store.get(id);
      if (!msg) return reply({ ok: false, error: 'Ta wiadomość już nie istnieje.' });
      // Starsze wiadomości (sprzed kont) nie mają accountId – wtedy rozpoznajemy autora po nicku.
      const owner = msg.accountId ? msg.accountId === user.accountId : msg.nick === user.nick;
      if (!owner) return reply({ ok: false, error: 'Możesz usuwać tylko własne wiadomości.' });
      await store.remove(id);
      // Ślad usunięcia: urządzenia, które były offline, dowiedzą się o nim przy następnym logowaniu
      // ('sync:deleted') i usuną wiadomość ze swojego archiwum lokalnego.
      await store.addTombstone(id).catch((err) => console.error('Nie udało się zapisać śladu usunięcia:', err.message));
      io.emit('messageDeleted', id);
      reply({ ok: true });
    } catch (err) {
      console.error('Błąd usuwania wiadomości:', err.message);
      reply({ ok: false, error: 'Nie udało się usunąć wiadomości.' });
    }
  });

  // Lista wiadomości usuniętych od `since` (czas serwera). Klient czyści na jej podstawie archiwum lokalne.
  socket.on('sync:deleted', async (since, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!users.has(socket.id)) return reply({ ok: false });
    if (rateLimited(socket, 'syncDeleted', 10, 60000)) return reply({ ok: false });
    try {
      const now = Date.now();
      const ids = await store.tombstonesSince(Number(since) > 0 ? Number(since) : 0);
      reply({ ok: true, ids, now });
    } catch (err) {
      console.error('Błąd synchronizacji usuniętych wiadomości:', err.message);
      reply({ ok: false });
    }
  });

  socket.on('getFile', async (id, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!users.has(socket.id)) return reply({ ok: false, error: 'Najpierw dołącz do czatu.' });
    if (typeof id !== 'string' || id.length > 64) return reply({ ok: false, error: 'Nieprawidłowy plik.' });
    if (rateLimited(socket, 'getFile', 20, 10000)) {
      return reply({ ok: false, error: 'Zwolnij trochę – za dużo pobrań naraz.' });
    }
    try {
      // Pliki z kanału nsfw tylko dla osób, które potwierdziły pełnoletność.
      const meta = await store.get(id);
      if (meta && CHANNELS_BY_ID.get(meta.channel)?.nsfw && !socket.data.adult) {
        return reply({ ok: false, error: 'Ten plik jest tylko dla osób pełnoletnich.' });
      }
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
    const account = user && accountsById.get(user.accountId);
    if (!account) return reply({ ok: false });
    if (value !== null && !validAvatar(value)) {
      return reply({ ok: false, error: 'Nieprawidłowy avatar.' });
    }
    account.avatar = value;
    persistAccount(account);
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

  socket.on('gif', async (rawUrl, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const user = users.get(socket.id);
    if (!user) return reply({ ok: false, error: 'Najpierw dołącz do czatu.' });
    if (rateLimited(socket, 'gif', 5, 10000)) {
      return reply({ ok: false, error: 'Zwolnij trochę – za dużo GIFów naraz.' });
    }
    const url = await resolveGifLink(rawUrl);
    if (!url) {
      return reply({
        ok: false,
        error: 'Nie znaleziono GIFa pod tym linkiem. Wklej link https do strony GIFa na Tenor/Giphy albo bezpośredni link do obrazka.',
      });
    }
    await emitMessage(socket, user.nick, { kind: 'gif', url });
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
    const channel = socket.data.channel || DEFAULT_CHANNEL;
    socket.to(`ch:${channel}`).emit('typing', { nick: user.nick, isTyping: Boolean(isTyping), channel });
  });

  socket.on('disconnect', () => {
    const wasInVoice = voice.delete(socket.id);
    const user = users.get(socket.id);
    if (!user) return;
    users.delete(socket.id);
    // Komunikat o wyjściu tylko gdy to była ostatnia otwarta karta tego konta.
    if (!isOnline(user.accountId)) {
      const channel = socket.data.channel || DEFAULT_CHANNEL;
      socket.to(`ch:${channel}`).emit('typing', { nick: user.nick, isTyping: false, channel });
      systemMessage(`${user.nick} opuścił(a) czat`);
    }
    broadcastUsers();
    if (wasInVoice) broadcastVoice();
  });
});

async function start() {
  await store.init();
  console.log(`Historia: ${store.label}, wiadomości i pliki usuwane po ${RETENTION_DAYS} dn.`);

  for (const account of await store.loadAccounts()) indexAccount(account);
  console.log(`Wczytano kont: ${accountsById.size}`);

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
