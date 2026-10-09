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
const MAX_SIGNAL_CHARS = 200000; // maksymalny rozmiar jednego sygnału WebRTC (oferta/odpowiedź/kandydat)
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
// Avatar i baner: zwykłe obrazy klient zmniejsza (JPEG), a animowane GIF-y przesyła w oryginale.
const MAX_AVATAR_CHARS = 30000; // statyczny avatar jako data-URL (klient zmniejsza go do 128x128)
const GIF_AVATAR_BYTES = 600 * 1024; // animowany avatar (GIF)
const GIF_BANNER_BYTES = 1536 * 1024; // animowany baner (GIF)
const MAX_MEDIA_BYTES = (Number(process.env.MAX_MEDIA_MB) || 100) * 1024 * 1024; // łączny budżet avatarów i banerów

// Własne emoji serwera (jak na Discordzie): wspólne dla wszystkich, używane jako :nazwa: i w reakcjach.
const MAX_EMOJI = 100;
const EMOJI_STATIC_CHARS = 100000; // statyczne emoji (klient zmniejsza je do 128x128)
const EMOJI_GIF_BYTES = 256 * 1024; // animowane emoji (GIF)
const MAX_REACTIONS_PER_MESSAGE = 20; // różnych emoji pod jedną wiadomością
const MAX_REACTORS_PER_EMOJI = 100;

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Avatary i banery jako zwykłe obrazy (a nie data-URL w każdej wiadomości socketowej). Adres zawiera
// wersję (?v=…), więc przeglądarka trzyma obraz w pamięci podręcznej „na zawsze” i pobiera go raz.
app.get('/media/:kind/:id', (req, res) => {
  const { kind, id } = req.params;
  if (!['avatar', 'banner', 'emoji'].includes(kind) || !/^[0-9a-f-]{12,36}$/.test(id)) return res.sendStatus(404);
  // avatar i baner należą do konta, emoji do serwera
  const owner = kind === 'emoji' ? emojiById.get(id) : accountsById.get(id);
  const dataUrl = kind === 'emoji' ? owner && owner.data : owner && owner[kind];
  const match = typeof dataUrl === 'string' && /^data:(image\/(?:jpeg|png|webp|gif));base64,/.exec(dataUrl);
  if (!match) return res.sendStatus(404);
  const body = Buffer.from(dataUrl.slice(match[0].length), 'base64');
  res.set({
    'Content-Type': match[1],
    'Content-Length': body.length,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  res.send(body);
});

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
    gifAvatarBytes: GIF_AVATAR_BYTES,
    gifBannerBytes: GIF_BANNER_BYTES,
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

// ---------- Własne emoji ----------
const emojiById = new Map(); // id -> { id, name, data, v, animated, by, createdAt }

function emojiNameTaken(name) {
  const lower = name.toLowerCase();
  for (const e of emojiById.values()) if (e.name.toLowerCase() === lower) return true;
  return false;
}

// Tak emoji widzą klienci: adres obrazu z wersją (cache), bez ciężkiego data-URL.
function publicEmoji(e) {
  return {
    id: e.id,
    name: e.name,
    url: `/media/emoji/${e.id}?v=${e.v}`,
    animated: e.animated,
    by: e.by ? accountsById.get(e.by)?.nick || null : null,
    byId: e.by || null,
  };
}

function emojiList() {
  return Array.from(emojiById.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(publicEmoji);
}

function broadcastEmoji() {
  io.emit('emoji:list', emojiList());
}

// Czy to poprawna reakcja: własne emoji :nazwa: (musi istnieć) albo zwykłe emoji Unicode?
function validReactionEmoji(value) {
  if (typeof value !== 'string' || !value || value.length > 24) return false;
  const custom = /^:([A-Za-z0-9_]{2,32}):$/.exec(value);
  if (custom) return emojiNameTaken(custom[1]);
  return /\p{Extended_Pictographic}/u.test(value) && /^[\p{Extended_Pictographic}‍️\u{1f3fb}-\u{1f3ff}]+$/u.test(value);
}

// Reakcje w formie dla klientów: { emoji: { ids: [accountId...], nicks: [pierwsze nicki do podpowiedzi] } }
function publicReactions(reactions) {
  const out = {};
  for (const [emoji, ids] of Object.entries(reactions || {})) {
    out[emoji] = { ids, nicks: ids.slice(0, 12).map((id) => accountsById.get(id)?.nick).filter(Boolean) };
  }
  return out;
}

const restorable = new Map(); // id świeżo założonych kont -> kiedy (okno na odtworzenie profilu z kopii zapasowej)

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
    .map(([id, s]) => ({
      id,
      nick: users.get(id).nick,
      muted: s.muted,
      deafened: s.deafened,
      sharing: Boolean(s.sharing), // udostępnia ekran
    }));
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

const dataUrlChars = (bytes) => Math.ceil(bytes / 3) * 4 + 40; // rozmiar obrazu po zakodowaniu w base64

// Sprawdza data-URL obrazu: dozwolony typ, limit rozmiaru (GIF ma własny) i zgodność nagłówka pliku z typem.
function isValidImageDataUrl(value, maxStaticChars, maxGifBytes) {
  if (typeof value !== 'string') return false;
  const m = /^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!m) return false;
  const [, type, b64] = m;
  if (value.length > (type === 'gif' ? dataUrlChars(maxGifBytes) : maxStaticChars)) return false;
  const head = Buffer.from(b64.slice(0, 24), 'base64');
  const tag = (from, to) => head.subarray(from, to).toString('latin1');
  if (type === 'jpeg') return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (type === 'png') return head[0] === 0x89 && tag(1, 4) === 'PNG';
  if (type === 'gif') return tag(0, 4) === 'GIF8';
  return tag(0, 4) === 'RIFF' && tag(8, 12) === 'WEBP';
}

function validAvatar(value) {
  return isValidImageDataUrl(value, MAX_AVATAR_CHARS, GIF_AVATAR_BYTES);
}

// Wersja obrazu w adresie – zmienia się razem z obrazem, więc cache przeglądarki nigdy nie jest nieaktualny.
function mediaVersion(value) {
  return value ? crypto.createHash('sha1').update(value).digest('hex').slice(0, 12) : null;
}

function mediaUrl(account, kind) {
  if (!account[kind]) return null;
  const versionKey = `${kind}V`;
  account[versionKey] = account[versionKey] || mediaVersion(account[kind]);
  return `/media/${kind}/${account.id}?v=${account[versionKey]}`;
}

// Czy mieści się jeszcze w łącznym budżecie na avatary i banery (chroni pamięć serwera przed wieloma GIF-ami)?
function mediaBudgetOk(account, field, value) {
  let total = 0;
  for (const a of accountsById.values()) total += (a.avatar ? a.avatar.length : 0) + (a.banner ? a.banner.length : 0);
  total -= account[field] ? account[field].length : 0;
  return total + (value ? value.length : 0) <= MAX_MEDIA_BYTES * 1.4;
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
// ---------- Profil (miniprofil jak na Discordzie) ----------
const STATUSES = new Set(['online', 'idle', 'dnd']);
const MAX_BIO = 190;
const MAX_PRONOUNS = 30;
const MAX_STATUS_TEXT = 60;
// Czcionki nicku do wyboru (identyfikatory – krój definiuje klient; zamiast „default” nie zapisujemy nic)
const NICK_FONTS = new Set([
  'default', 'pacifico', 'lobster', 'caveat', 'orbitron', 'pixel',
  'bebas', 'playfair', 'fredoka', 'typewriter', 'creepster', 'mono',
]);
const MAX_BANNER_CHARS = 60000; // baner jako data-URL (klient zmniejsza go do 600x200)

// Tekst wielowierszowy (opis „O mnie”): zachowuje maksymalnie jedną pustą linię między akapitami.
function cleanMultiline(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength);
}

function validBanner(value) {
  return isValidImageDataUrl(value, MAX_BANNER_CHARS, GIF_BANNER_BYTES);
}

function validColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

// Pola profilu edytowane przez użytkownika
function profileOf(account) {
  return {
    bio: account.bio || '',
    pronouns: account.pronouns || '',
    statusText: account.statusText || '',
    status: account.status || 'online',
    bannerColor: account.bannerColor || null,
    banner: mediaUrl(account, 'banner'),
    nickColor: account.nickColor || null,
    nickFont: account.nickFont || null,
  };
}

// Waliduje pola profilu z `payload` (tylko te, które przyszły). Zwraca poprawne pola w `next`
// i listę błędów – zapis profilu odrzuca całość przy błędzie, a odtwarzanie po resecie pomija błędne pola.
function sanitizeProfile(account, payload) {
  const next = {};
  const errors = [];
  if ('bio' in payload) next.bio = cleanMultiline(payload.bio, MAX_BIO);
  if ('pronouns' in payload) next.pronouns = cleanText(payload.pronouns, MAX_PRONOUNS);
  if ('statusText' in payload) next.statusText = cleanText(payload.statusText, MAX_STATUS_TEXT);
  if ('status' in payload) {
    if (STATUSES.has(payload.status)) next.status = payload.status;
    else errors.push('Nieprawidłowy status.');
  }
  if ('bannerColor' in payload) {
    if (payload.bannerColor === null || validColor(payload.bannerColor)) next.bannerColor = payload.bannerColor;
    else errors.push('Nieprawidłowy kolor banera.');
  }
  if ('nickColor' in payload) {
    if (payload.nickColor === null || validColor(payload.nickColor)) next.nickColor = payload.nickColor;
    else errors.push('Nieprawidłowy kolor nicku.');
  }
  if ('nickFont' in payload) {
    if (payload.nickFont === null || payload.nickFont === 'default') {
      next.nickFont = null; // czcionka domyślna
    } else if (typeof payload.nickFont === 'string' && NICK_FONTS.has(payload.nickFont)) {
      next.nickFont = payload.nickFont;
    } else {
      errors.push('Nieprawidłowa czcionka nicku.');
    }
  }
  if ('banner' in payload) {
    if (payload.banner !== null && !validBanner(payload.banner)) {
      errors.push('Nieprawidłowy obraz banera (GIF do 1,5 MB, inne formaty są zmniejszane).');
    } else if (payload.banner && !mediaBudgetOk(account, 'banner', payload.banner)) {
      errors.push('Serwer wyczerpał limit miejsca na avatary i banery.');
    } else {
      next.banner = payload.banner;
      next.bannerV = mediaVersion(payload.banner);
    }
  }
  return { next, errors };
}

// Profil widoczny dla innych (po kliknięciu osoby)
function publicProfile(account) {
  return {
    id: account.id,
    nick: account.nick,
    avatar: mediaUrl(account, 'avatar'),
    createdAt: account.createdAt,
    online: isOnline(account.id),
    ...profileOf(account),
  };
}

function broadcastUsers() {
  const online = new Map(); // jedna pozycja na konto, nawet gdy otwarto kilka kart
  for (const { accountId } of users.values()) {
    const account = accountsById.get(accountId);
    if (account) {
      online.set(accountId, {
        id: account.id,
        nick: account.nick,
        avatar: mediaUrl(account, 'avatar'),
        status: account.status || 'online',
        statusText: account.statusText || '',
        nickColor: account.nickColor || null,
        nickFont: account.nickFont || null,
      });
    }
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

// ---------- Wzmianki (@nick) i odpowiedzi ----------
// Wzmianki rozpoznajemy po stronie serwera: po „@” szukamy najdłuższego pasującego nicku (nick może mieć spacje).
// Dzięki temu serwer wie, kogo powiadomić, a klient dostaje listę osób do podświetlenia.
const WORD_CHAR = /[\p{L}\p{N}_]/u;

function parseMentions(text) {
  const found = new Map();
  for (let i = text.indexOf('@'); i !== -1 && found.size < 10; i = text.indexOf('@', i + 1)) {
    if (i > 0 && WORD_CHAR.test(text[i - 1])) continue; // np. adres e-mail, to nie wzmianka
    const rest = text.slice(i + 1);
    for (let len = Math.min(MAX_NICK_LENGTH, rest.length); len >= 1; len--) {
      const account = accountsByNick.get(rest.slice(0, len).toLowerCase());
      if (!account) continue;
      if (rest.length > len && WORD_CHAR.test(rest[len])) continue; // „@Ania2” to nie „@Ania”
      found.set(account.id, { id: account.id, nick: account.nick });
      break;
    }
  }
  return Array.from(found.values());
}

// Krótki opis oryginału, który widać nad odpowiedzią. Treści nie kopiujemy do odpowiedzi na stałe –
// gdy autor usunie wiadomość, odpowiedź przestaje ją cytować.
function replySnapshot(id, original) {
  if (!original) return { id, missing: true };
  const preview =
    original.kind === 'gif' ? 'GIF' : original.kind === 'file' ? `📎 ${original.name}` : String(original.text || '').slice(0, 120);
  return { id, accountId: original.accountId || null, nick: original.nick, kind: original.kind, preview };
}

// Zamienia w wiadomościach `replyToId` na opis oryginału (`replyTo`), jednym zapytaniem do magazynu.
async function attachReplies(messages) {
  const ids = Array.from(new Set(messages.map((m) => m.replyToId).filter(Boolean)));
  if (!ids.length) return messages;
  let originals = new Map();
  try {
    originals = await store.getMany(ids);
  } catch (err) {
    console.error('Nie udało się wczytać oryginałów odpowiedzi:', err.message);
  }
  return messages.map((m) => {
    if (!m.replyToId) return m;
    const { replyToId, ...rest } = m;
    return { ...rest, replyTo: replySnapshot(replyToId, originals.get(replyToId)) };
  });
}

async function sendHistory(socket, channelId) {
  let messages = [];
  try {
    // Pliki bez zawartości – pobierane na żądanie przez 'getFile'.
    messages = await store.recent(Date.now() - RETENTION_MS, HISTORY_LIMIT, channelId);
  } catch (err) {
    console.error('Nie udało się wczytać historii:', err.message);
  }
  // Style nicków autorów (także tych, którzy są offline), żeby stare wiadomości wyglądały jak należy.
  const styles = {};
  for (const m of messages) {
    const a = m.accountId && accountsById.get(m.accountId);
    if (a && (a.nickColor || a.nickFont)) styles[a.id] = { nickColor: a.nickColor || null, nickFont: a.nickFont || null };
  }
  const withReactions = messages.map((m) => (m.reactions ? { ...m, reactions: publicReactions(m.reactions) } : m));
  socket.emit('history', { channel: channelId, messages: await attachReplies(withReactions), styles });
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
  const nsfw = Boolean(CHANNELS_BY_ID.get(channel)?.nsfw);
  // Klienci dostają opis oryginału (`replyTo`), a w magazynie zostaje samo `replyToId`.
  const [wire] = await attachReplies([msg]);
  io.to(`ch:${channel}`).emit('message', wire);
  io.to(nsfw ? 'adult' : 'lobby').except(`ch:${channel}`).emit('activity', { channel });

  // Oznaczone osoby, które oglądają inny kanał, dostają osobne powiadomienie (czerwony licznik przy kanale).
  for (const mention of msg.mentions || []) {
    for (const [socketId, u] of users) {
      if (u.accountId !== mention.id) continue;
      const target = io.sockets.sockets.get(socketId);
      if (!target || target.rooms.has(`ch:${channel}`) || (nsfw && !target.data.adult)) continue;
      target.emit('activity', { channel, mention: true });
    }
  }
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
    let isNewAccount = false;
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
      const avatar = validAvatar(payload.avatar) ? payload.avatar : null;
      account = {
        id: crypto.randomUUID(),
        nick,
        avatar,
        avatarV: mediaVersion(avatar),
        tokenHash: hashToken(token),
        createdAt: Date.now(),
      };
      isNewAccount = true;
      restorable.set(account.id, Date.now()); // przez chwilę urządzenie może odtworzyć profil z kopii zapasowej
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
      avatar: mediaUrl(account, 'avatar'),
      id: socket.id,
      accountId: account.id,
      createdAt: account.createdAt,
      profile: profileOf(account),
      isNew: isNewAccount, // true = konto właśnie utworzono (np. serwer zgubił dane po restarcie)
      emoji: emojiList(),
      maxEmoji: MAX_EMOJI,
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

  // ---------- Własne emoji: dodawanie i usuwanie ----------
  socket.on('emoji:add', async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const user = users.get(socket.id);
    if (!user) return reply({ ok: false, error: 'Najpierw dołącz do czatu.' });
    if (!payload || typeof payload !== 'object') return reply({ ok: false, error: 'Nieprawidłowe dane.' });
    if (rateLimited(socket, 'emojiAdd', 8, 60000)) {
      return reply({ ok: false, error: 'Zbyt wiele nowych emoji naraz. Spróbuj za chwilę.' });
    }
    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    if (!/^[A-Za-z0-9_]{2,32}$/.test(name)) {
      return reply({ ok: false, error: 'Nazwa: 2–32 znaki – litery bez polskich znaków, cyfry i podkreślenie.' });
    }
    if (emojiNameTaken(name)) return reply({ ok: false, error: `Emoji :${name}: już istnieje.` });
    if (emojiById.size >= MAX_EMOJI) return reply({ ok: false, error: `Serwer ma już maksymalną liczbę emoji (${MAX_EMOJI}).` });
    if (!isValidImageDataUrl(payload.image, EMOJI_STATIC_CHARS, EMOJI_GIF_BYTES)) {
      return reply({ ok: false, error: 'Nieprawidłowy obraz emoji (GIF do 256 KB, inne formaty są zmniejszane).' });
    }

    const emoji = {
      id: crypto.randomBytes(6).toString('hex'),
      name,
      data: payload.image,
      v: mediaVersion(payload.image),
      animated: payload.image.startsWith('data:image/gif'),
      by: user.accountId,
      createdAt: Date.now(),
    };
    emojiById.set(emoji.id, emoji);
    try {
      await store.saveEmoji(emoji);
    } catch (err) {
      console.error('Nie udało się zapisać emoji:', err.message);
    }
    reply({ ok: true, emoji: publicEmoji(emoji) });
    broadcastEmoji();
  });

  socket.on('emoji:delete', async (id, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const user = users.get(socket.id);
    if (!user) return reply({ ok: false, error: 'Najpierw dołącz do czatu.' });
    const emoji = typeof id === 'string' ? emojiById.get(id) : null;
    if (!emoji) return reply({ ok: false, error: 'Nie ma takiego emoji.' });
    if (emoji.by !== user.accountId) return reply({ ok: false, error: 'Możesz usuwać tylko własne emoji.' });
    emojiById.delete(id);
    try {
      await store.deleteEmoji(id);
    } catch (err) {
      console.error('Nie udało się usunąć emoji:', err.message);
    }
    reply({ ok: true });
    broadcastEmoji();
  });

  // ---------- Reakcje na wiadomości (kliknięcie dodaje, ponowne kliknięcie usuwa) ----------
  socket.on('react', async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const user = users.get(socket.id);
    if (!user) return reply({ ok: false, error: 'Najpierw dołącz do czatu.' });
    if (!payload || typeof payload.id !== 'string' || payload.id.length > 64) {
      return reply({ ok: false, error: 'Nieprawidłowa wiadomość.' });
    }
    if (!validReactionEmoji(payload.emoji)) return reply({ ok: false, error: 'Nieprawidłowe emoji.' });
    if (rateLimited(socket, 'react', 25, 10000)) return reply({ ok: false, error: 'Zwolnij trochę.' });

    try {
      const msg = await store.get(payload.id);
      if (!msg) return reply({ ok: false, error: 'Ta wiadomość już nie istnieje.' });
      // Reagować można tylko w kanale, który oglądasz (i tylko w nsfw po potwierdzeniu pełnoletności).
      const channel = msg.channel || DEFAULT_CHANNEL;
      if (channel !== socket.data.channel) return reply({ ok: false, error: 'Ta wiadomość jest w innym kanale.' });
      if (CHANNELS_BY_ID.get(channel)?.nsfw && !socket.data.adult) return reply({ ok: false, error: 'Brak dostępu.' });

      const reactions = { ...(msg.reactions || {}) };
      const who = new Set(reactions[payload.emoji] || []);
      if (who.has(user.accountId)) {
        who.delete(user.accountId);
      } else {
        if (!reactions[payload.emoji] && Object.keys(reactions).length >= MAX_REACTIONS_PER_MESSAGE) {
          return reply({ ok: false, error: `Pod wiadomością może być najwyżej ${MAX_REACTIONS_PER_MESSAGE} różnych reakcji.` });
        }
        if (who.size >= MAX_REACTORS_PER_EMOJI) return reply({ ok: false, error: 'Ta reakcja ma już maksymalną liczbę osób.' });
        who.add(user.accountId);
      }
      if (who.size) reactions[payload.emoji] = Array.from(who);
      else delete reactions[payload.emoji];

      await store.setReactions(payload.id, reactions);
      io.to(`ch:${channel}`).emit('reactions', { id: payload.id, reactions: publicReactions(reactions) });
      reply({ ok: true });
    } catch (err) {
      console.error('Błąd reakcji:', err.message);
      reply({ ok: false, error: 'Nie udało się dodać reakcji.' });
    }
  });

  // Zapis własnego profilu (wszystkie pola opcjonalne – zmieniamy tylko te, które przyszły).
  socket.on('profile:update', async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const user = users.get(socket.id);
    const account = user && accountsById.get(user.accountId);
    if (!account) return reply({ ok: false, error: 'Najpierw dołącz do czatu.' });
    if (!payload || typeof payload !== 'object') return reply({ ok: false, error: 'Nieprawidłowe dane.' });
    if (rateLimited(socket, 'profile', 10, 60000)) {
      return reply({ ok: false, error: 'Zbyt wiele zmian profilu. Spróbuj za chwilę.' });
    }

    const { next, errors } = sanitizeProfile(account, payload);
    if (errors.length) return reply({ ok: false, error: errors[0] });

    Object.assign(account, next);
    await persistAccount(account);
    reply({ ok: true, profile: profileOf(account) });
    broadcastUsers(); // zmienił się status widoczny na liście osób
  });

  // Odtworzenie profilu z lokalnej kopii zapasowej urządzenia. Dozwolone raz, tuż po założeniu konta –
  // tak urządzenie naprawia się samo, gdy serwer zgubi dane (restart darmowego Rendera).
  socket.on('profile:restore', async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const user = users.get(socket.id);
    const account = user && accountsById.get(user.accountId);
    if (!account) return reply({ ok: false, error: 'Najpierw dołącz do czatu.' });
    const since = restorable.get(account.id);
    if (!since || Date.now() - since > 10 * 60 * 1000) return reply({ ok: false, error: 'Odtwarzanie niedostępne.' });
    if (!payload || typeof payload !== 'object') return reply({ ok: false, error: 'Nieprawidłowe dane.' });
    restorable.delete(account.id);

    // Avatar (jeśli kopia go zawiera i mieści się w limitach)
    if (validAvatar(payload.avatar) && mediaBudgetOk(account, 'avatar', payload.avatar)) {
      account.avatar = payload.avatar;
      account.avatarV = mediaVersion(payload.avatar);
    }
    // Data założenia konta („Członek od”) – tylko rozsądna wartość z przeszłości
    if (Number.isFinite(payload.createdAt) && payload.createdAt > 1.6e12 && payload.createdAt <= Date.now()) {
      account.createdAt = payload.createdAt;
    }
    // Pozostałe pola profilu: błędne pomijamy, poprawne zapisujemy
    const { bio, pronouns, statusText, status, bannerColor, banner, nickColor, nickFont } = payload;
    Object.assign(
      account,
      sanitizeProfile(account, { bio, pronouns, statusText, status, bannerColor, banner, nickColor, nickFont }).next
    );

    await persistAccount(account);
    reply({ ok: true, avatar: mediaUrl(account, 'avatar'), createdAt: account.createdAt, profile: profileOf(account) });
    broadcastUsers();
  });

  // Profil dowolnej osoby (po id konta albo nicku) – także gdy jest offline.
  socket.on('profile:get', (query, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!users.has(socket.id)) return reply({ ok: false, error: 'Najpierw dołącz do czatu.' });
    if (rateLimited(socket, 'profileGet', 40, 10000)) return reply({ ok: false, error: 'Zwolnij trochę.' });
    let account = null;
    if (query && typeof query.id === 'string') account = accountsById.get(query.id);
    if (!account && query && typeof query.nick === 'string') account = accountsByNick.get(query.nick.toLowerCase());
    if (!account) return reply({ ok: false, error: 'Nie znaleziono profilu tej osoby.' });
    reply({ ok: true, profile: publicProfile(account) });
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
    voice.set(socket.id, { muted: false, deafened: false, sharing: false });
    reply({ ok: true, peers });
    broadcastVoice();
  });

  socket.on('voice:leave', () => leaveVoice(socket));

  socket.on('voice:state', (state) => {
    const entry = voice.get(socket.id);
    if (!entry || !state) return;
    entry.muted = Boolean(state.muted);
    entry.deafened = Boolean(state.deafened);
    entry.sharing = Boolean(state.sharing);
    broadcastVoice();
  });

  socket.on('voice:signal', (payload) => {
    if (!voice.has(socket.id) || !payload) return;
    const { to, data } = payload;
    if (typeof to !== 'string' || !voice.has(to) || to === socket.id) return;
    // Opis sesji WebRTC z obrazem ekranu potrafi mieć dziesiątki tysięcy znaków, więc limit jest hojny
    // (ma tylko chronić przed nadużyciami). Wcześniejsze 20 000 po cichu gubiło oferty i zawieszało połączenie.
    if (!data || typeof data !== 'object') return;
    if (JSON.stringify(data).length > MAX_SIGNAL_CHARS) {
      console.warn(`Odrzucono zbyt duży sygnał głosowy (> ${MAX_SIGNAL_CHARS} znaków).`);
      return;
    }
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
      // `code: 'gone'` – serwer już jej nie ma (wygasła lub serwer zgubił dane); klient usunie wtedy swoją lokalną kopię.
      if (!msg) return reply({ ok: false, code: 'gone', error: 'Ta wiadomość już nie istnieje na serwerze.' });
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
      return reply({ ok: false, error: 'Nieprawidłowy avatar (GIF do 600 KB, inne formaty są zmniejszane).' });
    }
    if (value && !mediaBudgetOk(account, 'avatar', value)) {
      return reply({ ok: false, error: 'Serwer wyczerpał limit miejsca na avatary i banery.' });
    }
    account.avatar = value;
    account.avatarV = mediaVersion(value);
    persistAccount(account);
    reply({ ok: true, avatar: mediaUrl(account, 'avatar') });
    broadcastUsers();
  });

  // Wiadomość tekstowa: albo sam tekst, albo { text, replyTo: id wiadomości, ping: czy powiadomić autora oryginału }
  socket.on('message', async (payload) => {
    const user = users.get(socket.id);
    const body = typeof payload === 'string' ? { text: payload } : payload && typeof payload === 'object' ? payload : null;
    const text = body ? cleanText(body.text, MAX_MESSAGE_LENGTH) : '';
    if (!user || !text) return;
    if (rateLimited(socket, 'msg', 10, 10000)) return;

    const extra = { kind: 'text', text };
    const mentions = parseMentions(text);

    if (typeof body.replyTo === 'string' && body.replyTo.length <= 64) {
      const original = await store.get(body.replyTo).catch(() => null);
      // Odpowiedzieć można tylko na wiadomość z tego samego kanału; w przeciwnym razie wysyłamy zwykłą wiadomość.
      if (original && (original.channel || DEFAULT_CHANNEL) === (socket.data.channel || DEFAULT_CHANNEL)) {
        extra.replyToId = original.id;
        const author = original.accountId && accountsById.get(original.accountId);
        // Odpowiedź domyślnie powiadamia autora oryginału (jak „@WŁ.” na Discordzie), chyba że to my.
        if (body.ping !== false && author && author.id !== user.accountId && !mentions.some((m) => m.id === author.id)) {
          mentions.push({ id: author.id, nick: author.nick, reply: true });
        }
      }
    }
    if (mentions.length) extra.mentions = mentions;
    await emitMessage(socket, user.nick, extra);
  });

  // Podpowiedzi do @: osoby pasujące do wpisanych liter (online na początku)
  socket.on('mention:search', (query, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!users.has(socket.id)) return reply({ ok: false });
    if (rateLimited(socket, 'mentionSearch', 30, 10000)) return reply({ ok: false });
    const q = cleanText(typeof query === 'string' ? query : '', MAX_NICK_LENGTH).toLowerCase();
    const matches = [];
    for (const account of accountsById.values()) {
      const lower = account.nick.toLowerCase();
      if (q && !lower.includes(q)) continue;
      matches.push({ account, online: isOnline(account.id), starts: lower.startsWith(q) });
    }
    matches.sort((a, b) => b.online - a.online || b.starts - a.starts || a.account.nick.localeCompare(b.account.nick));
    reply({
      ok: true,
      results: matches.slice(0, 8).map(({ account, online }) => ({
        id: account.id,
        nick: account.nick,
        avatar: mediaUrl(account, 'avatar'),
        online,
        status: account.status || 'online',
      })),
    });
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

  for (const emoji of await store.loadEmoji()) emojiById.set(emoji.id, emoji);
  console.log(`Wczytano emoji: ${emojiById.size}`);

  for (const account of await store.loadAccounts()) indexAccount(account);
  console.log(`Wczytano kont: ${accountsById.size}`);

  // Darmowy Render usypia usługę po ok. 15 minutach bez ruchu z zewnątrz (rozmowa głosowa idzie
  // bezpośrednio między użytkownikami, więc serwer nic nie widzi), a przy wznowieniu kasuje dane.
  // Pingując własny publiczny adres co 10 minut, nie dopuszczamy do uśpienia.
  const publicUrl = process.env.RENDER_EXTERNAL_URL || process.env.KEEPALIVE_URL;
  if (publicUrl) {
    setInterval(() => {
      fetch(`${publicUrl.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(15000) }).catch((err) =>
        console.error('Keep-alive nie powiódł się:', err.message)
      );
    }, 10 * 60 * 1000).unref();
    console.log(`Keep-alive: ping ${publicUrl}/health co 10 min`);
  }

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
