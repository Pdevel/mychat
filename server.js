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

// Dane są trwałe tylko z bazą MongoDB (MONGODB_URI) albo z dyskiem, który przeżywa wdrożenia (DATA_DIR na
// dysku trwałym). Bez tego darmowy Render kasuje wszystko przy każdym wdrożeniu i uśpieniu.
const DATA_IS_PERSISTENT = Boolean(process.env.MONGODB_URI || process.env.DATA_DIR);

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
  if (!['avatar', 'banner', 'emoji', 'group'].includes(kind) || !/^[0-9a-f-]{12,36}$/.test(id)) return res.sendStatus(404);
  // avatar i baner należą do konta, emoji do serwera, obrazek – do grupy
  const owner = kind === 'emoji' ? emojiById.get(id) : kind === 'group' ? groupsById.get(id) : accountsById.get(id);
  const dataUrl = kind === 'emoji' ? owner && owner.data : kind === 'group' ? owner && owner.icon : owner && owner[kind];
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
    persistent: DATA_IS_PERSISTENT, // czy konta, historia i emoji przeżyją restart serwera
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
// socket.id -> { groupId, muted, deafened, sharing } (osoby na kanale głosowym; każda grupa ma własny kanał głosowy)
const voice = new Map();

function voiceList(groupId) {
  return Array.from(voice.entries())
    .filter(([id, s]) => s.groupId === groupId && users.has(id))
    .map(([id, s]) => ({
      id,
      nick: users.get(id).nick,
      muted: s.muted,
      deafened: s.deafened,
      sharing: Boolean(s.sharing), // udostępnia ekran
    }));
}

// Lista osób na głosowym dostaje tylko ta grupa, do której kanał należy.
function broadcastVoice(groupId) {
  io.to(`grp:${groupId}`).emit('voice:users', { groupId, users: voiceList(groupId) });
}

function broadcastAllVoice() {
  new Set(Array.from(voice.values()).map((s) => s.groupId)).forEach(broadcastVoice);
}

function leaveVoice(socket) {
  const entry = voice.get(socket.id);
  if (entry && voice.delete(socket.id)) broadcastVoice(entry.groupId);
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

// Czy plik PNG/WebP jest animowany (APNG / animowany WebP)? GIF traktujemy zawsze jak animację.
function isAnimatedBuffer(type, buf) {
  if (type === 'gif') return true;
  if (type === 'webp') return buf.toString('latin1', 12, 16) === 'VP8X' && (buf[20] & 0x02) !== 0;
  if (type === 'png') {
    for (let pos = 8; pos + 8 <= buf.length; ) {
      const name = buf.toString('latin1', pos + 4, pos + 8);
      if (name === 'acTL') return true; // fragment APNG stoi przed danymi obrazu
      if (name === 'IDAT' || name === 'IEND') return false;
      pos += 12 + buf.readUInt32BE(pos);
    }
  }
  return false;
}

function isAnimatedDataUrl(value) {
  const m = /^data:image\/(png|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(value || '');
  return Boolean(m) && isAnimatedBuffer(m[1], Buffer.from(m[2], 'base64'));
}

// Sprawdza data-URL obrazu: dozwolony typ, limit rozmiaru (GIF ma własny) i zgodność nagłówka pliku z typem.
// `maxAnimatedBytes` (opcjonalnie): większy limit także dla animowanych PNG/WebP (np. emoji).
function isValidImageDataUrl(value, maxStaticChars, maxGifBytes, maxAnimatedBytes = 0) {
  if (typeof value !== 'string') return false;
  const m = /^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!m) return false;
  const [, type, b64] = m;
  let tooBig = value.length > (type === 'gif' ? dataUrlChars(maxGifBytes) : maxStaticChars);
  if (tooBig && type !== 'gif' && type !== 'jpeg' && maxAnimatedBytes && value.length <= dataUrlChars(maxAnimatedBytes)) {
    tooBig = !isAnimatedBuffer(type, Buffer.from(b64, 'base64')); // za duży jako zwykły obraz, ale może być animacją
  }
  if (tooBig) return false;
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
  // Każdy widzi tylko osoby, z którymi dzieli jakąś grupę (oraz siebie) – nie ma już wspólnej sali dla wszystkich.
  const everyone = Array.from(online.values());
  for (const [socketId, { accountId }] of users) {
    const target = io.sockets.sockets.get(socketId);
    if (!target) continue;
    const visible = new Set([accountId]);
    for (const g of groupsOf(accountId)) g.members.forEach((id) => visible.add(id));
    target.emit('users', everyone.filter((u) => visible.has(u.id)));
  }
}

// ---------- Kanały tekstowe ----------
// Rozmawia się wyłącznie w grupach: każdy kanał grupy ma osobną historię. Pełne wiadomości dostają tylko osoby,
// które oglądają dany kanał (pokój `ch:<id>`); reszta członków grupy dostaje lekkie powiadomienie `activity`.
// Nie ma kanałów wspólnych dla wszystkich – na początku trzeba dołączyć do grupy albo założyć własną.

// ---------- Wspólne oglądanie ----------
// Na kanale może trwać jedno „oglądanie razem”: ktoś zaprasza z linkiem do filmu, chętni dołączają, a gospodarz
// odpala odliczanie 3-2-1 – wszyscy dołączeni startują jednocześnie. Stan jest tylko w pamięci serwera.
const PARTY_EMOJI = ['🔥', '😍', '👏', '😂', '❤️', '😮'];
const parties = new Map(); // kanał -> { id, href, hostId, hostNick, viewers: Map(accountId -> nick), started }

function publicParty(channel) {
  const p = parties.get(channel);
  if (!p) return null;
  return {
    id: p.id,
    href: p.href,
    hostId: p.hostId,
    host: p.hostNick,
    viewers: Array.from(p.viewers, ([id, nick]) => ({ id, nick })),
    started: p.started,
  };
}

function broadcastParty(channel) {
  io.to(`ch:${channel}`).emit('party:update', { channel, party: publicParty(channel) });
}

// Zdejmuje to połączenie z oglądania; gdy wychodzi gospodarz, jego rolę przejmuje następna osoba.
function leaveParty(socket) {
  const channel = socket.data.party;
  socket.data.party = null;
  const user = users.get(socket.id);
  const p = channel && parties.get(channel);
  if (!p || !user || !p.viewers.delete(user.accountId)) return;
  if (!p.viewers.size) parties.delete(channel);
  else if (p.hostId === user.accountId) {
    const [id, nick] = p.viewers.entries().next().value;
    p.hostId = id;
    p.hostNick = nick;
  }
  broadcastParty(channel);
}

// Przenosi połączenie do kanału (opuszcza poprzedni pokój, wchodzi do nowego). `null` = żaden.
function enterChannel(socket, channelId) {
  if (socket.data.party && socket.data.party !== channelId) leaveParty(socket);
  if (socket.data.channel) socket.leave(`ch:${socket.data.channel}`);
  socket.data.channel = channelId || null;
  if (channelId) {
    socket.join(`ch:${channelId}`);
    socket.emit('party:update', { channel: channelId, party: publicParty(channelId) });
  }
}

// ---------- Grupy prywatne ----------
// Grupa to prywatna przestrzeń z własnym czatem (kanał `g_<id>`), do której mają dostęp tylko jej członkowie.
// Wchodzi się do niej JEDNORAZOWYM kodem: gdy ktoś go użyje, kod natychmiast wygasa i powstaje następny.
// Kod widzi i generuje wyłącznie twórca grupy. Członkowie dostają wiadomości z pokoju `ch:g_<id>`,
// a lekkie powiadomienia o aktywności z pokoju `grp:<id>`.
const MAX_GROUP_NAME = 30;
const MAX_GROUP_MEMBERS = 50;
const MAX_GROUPS_OWNED = 10; // ile grup może założyć jedno konto
const MAX_GROUPS_JOINED = 25; // do ilu grup w sumie może należeć jedno konto
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // bez 0/O i 1/I, żeby kod dało się przepisać bez pomyłek
const CODE_LENGTH = 8; // 32^8 ≈ 10^12 możliwości (40 bitów) + limit prób, więc zgadnięcie kodu jest nierealne

const groupsById = new Map(); // id -> { id, name, ownerId, members: [accountId], code, createdAt }
const groupsByCode = new Map(); // kod (bez myślnika) -> id grupy
const joinAttempts = new Map(); // accountId -> znaczniki czasu prób wpisania kodu

const groupChannel = (id) => `g_${id}`;
const isGroupMember = (group, accountId) => group.members.includes(accountId);
const formatCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;
const normalizeCode = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Kanały grupy: domyślny ma id `g_<grupa>` (tak jak przed wprowadzeniem własnych kanałów), kolejne `g_<grupa>_<kanał>`.
const GROUP_CHANNEL_RE = /^g_([0-9a-f]{12})(?:_([0-9a-f]{6}))?$/;
const groupChannelId = (group, chId) => (chId ? `g_${group.id}_${chId}` : `g_${group.id}`);

// Grupa, do której należy kanał (tylko jeśli taki kanał w niej naprawdę istnieje).
function groupOfChannel(channelId) {
  const match = typeof channelId === 'string' && GROUP_CHANNEL_RE.exec(channelId);
  const group = match && groupsById.get(match[1]);
  if (!group) return null;
  return group.channels.some((c) => c.id === (match[2] || '')) ? group : null;
}
const belongsToGroup = (channelId, groupId) =>
  typeof channelId === 'string' && (channelId === `g_${groupId}` || channelId.startsWith(`g_${groupId}_`));

// ---- Role i uprawnienia (jak na Discordzie) ----
// Twórca grupy ma zawsze wszystkie uprawnienia. Pozostali dostają je z roli @everyone i ze swoich ról.
// Role są uporządkowane od najwyższej: można zarządzać tylko rolami i osobami STOJĄCYMI NIŻEJ od własnej najwyższej roli.
const PERMISSIONS = ['admin', 'send', 'manageMessages', 'manageChannels', 'manageRoles', 'kick', 'invite', 'manageGroup'];
const DEFAULT_EVERYONE = ['send'];
const MAX_ROLES = 15;
const MAX_GROUP_CHANNELS = 15;
const MAX_ROLES_PER_MEMBER = 8;
const MAX_ROLE_NAME = 24;
const MAX_CHANNEL_NAME = 24;

// Uzupełnia grupy zapisane przed wprowadzeniem ról i kanałów.
function normalizeGroup(group) {
  if (!Array.isArray(group.channels) || !group.channels.length) group.channels = [{ id: '', name: 'ogólny' }];
  if (!Array.isArray(group.roles)) group.roles = [];
  if (!Array.isArray(group.everyone)) group.everyone = DEFAULT_EVERYONE.slice();
  if (!group.memberRoles || typeof group.memberRoles !== 'object') group.memberRoles = {};
  return group;
}

const roleIndex = (group, roleId) => group.roles.findIndex((r) => r.id === roleId);

function memberRoleIds(group, accountId) {
  const ids = group.memberRoles[accountId];
  return Array.isArray(ids) ? ids.filter((id) => roleIndex(group, id) !== -1) : [];
}

// Im niższa liczba, tym wyższa pozycja (twórca = -1, ktoś bez ról = Infinity).
function topRank(group, accountId) {
  if (group.ownerId === accountId) return -1;
  return memberRoleIds(group, accountId).reduce((best, id) => Math.min(best, roleIndex(group, id)), Infinity);
}

function permsOf(group, accountId) {
  if (group.ownerId === accountId) return new Set(PERMISSIONS);
  const set = new Set(group.everyone);
  for (const id of memberRoleIds(group, accountId)) group.roles[roleIndex(group, id)].perms.forEach((p) => set.add(p));
  return set.has('admin') ? new Set(PERMISSIONS) : set;
}
const can = (group, accountId, perm) => permsOf(group, accountId).has(perm);

// Czy to połączenie może pisać na swoim kanale (wymaga kanału grupy i uprawnienia „Pisanie wiadomości”).
function mayPost(socket) {
  const group = groupOfChannel(socket.data.channel);
  if (!group) return false; // poza grupą nie ma gdzie pisać
  const user = users.get(socket.id);
  return Boolean(user) && isGroupMember(group, user.accountId) && can(group, user.accountId, 'send');
}
const NO_POST_ERROR = 'Nie masz uprawnienia do pisania w tej grupie.';

const cleanPerms = (value, { allowAdmin = true } = {}) =>
  Array.from(new Set(Array.isArray(value) ? value : [])).filter((p) => PERMISSIONS.includes(p) && (allowAdmin || p !== 'admin'));
const cleanColor = (value) => (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : null);
const cleanChannelName = (value) =>
  cleanText(typeof value === 'string' ? value : '', MAX_CHANNEL_NAME).toLowerCase().replace(/\s+/g, '-').replace(/^-+|-+$/g, '');

function indexGroup(group) {
  normalizeGroup(group);
  groupsById.set(group.id, group);
  if (group.code) groupsByCode.set(group.code, group.id);
}

// Nowy, jeszcze nieużyty kod; stary (jeśli był) przestaje działać.
function rotateGroupCode(group) {
  if (group.code) groupsByCode.delete(group.code);
  let code;
  do {
    code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (groupsByCode.has(code));
  group.code = code;
  groupsByCode.set(code, group.id);
}

async function persistGroup(group) {
  try {
    await store.saveGroup(group);
  } catch (err) {
    console.error('Nie udało się zapisać grupy:', err.message);
  }
}

const groupsOf = (accountId) => Array.from(groupsById.values()).filter((g) => isGroupMember(g, accountId));

// Co klient wie o grupie. Kod dostaje tylko twórca i osoby z uprawnieniem „invite”.
function groupInfo(group, accountId) {
  const isOwner = group.ownerId === accountId;
  const perms = permsOf(group, accountId);
  const rank = topRank(group, accountId);
  const counts = new Map();
  for (const id of group.members) memberRoleIds(group, id).forEach((r) => counts.set(r, (counts.get(r) || 0) + 1));
  return {
    id: group.id,
    name: group.name,
    channel: groupChannel(group.id), // kanał domyślny
    channels: group.channels.map((c) => ({ id: groupChannelId(group, c.id), name: c.name, isDefault: !c.id })),
    isOwner,
    ownerId: group.ownerId,
    memberCount: group.members.length,
    maxMembers: MAX_GROUP_MEMBERS,
    icon: group.icon ? `/media/group/${group.id}?v=${group.iconV || (group.iconV = mediaVersion(group.icon))}` : null,
    perms: Array.from(perms),
    rank: rank === Infinity ? 9999 : rank,
    everyone: group.everyone.slice(),
    roles: group.roles.map((r) => ({ id: r.id, name: r.name, color: r.color || null, perms: r.perms.slice(), memberCount: counts.get(r.id) || 0 })),
    ...(perms.has('invite') ? { code: formatCode(group.code) } : {}),
  };
}

function accountSockets(accountId) {
  const sockets = [];
  for (const [socketId, u] of users) {
    const s = u.accountId === accountId && io.sockets.sockets.get(socketId);
    if (s) sockets.push(s);
  }
  return sockets;
}

function pushGroups(accountId) {
  const list = groupsOf(accountId).map((g) => groupInfo(g, accountId));
  accountSockets(accountId).forEach((s) => s.emit('groups', list));
}

function joinGroupRooms(accountId) {
  const groups = groupsOf(accountId);
  accountSockets(accountId).forEach((s) => groups.forEach((g) => s.join(`grp:${g.id}`)));
}

// Odbiera dostęp do grupy (wyjście, usunięcie): połączenia opuszczają jej pokoje, a te, które oglądały jej czat,
// wracają na kanał domyślny. Klient dostaje `group:removed`, żeby usunąć grupę z listy i swoje lokalne kopie.
async function revokeGroupAccess(accountId, group) {
  const channel = groupChannel(group.id);
  const channels = group.channels.map((c) => groupChannelId(group, c.id));
  for (const s of accountSockets(accountId)) {
    s.leave(`grp:${group.id}`);
    s.emit('group:removed', { groupId: group.id, channel, channels });
    // Kanał głosowy tej grupy kończy się dla osoby, która straciła do niej dostęp (klient rozłącza się sam).
    const inVoice = voice.get(s.id);
    if (inVoice && inVoice.groupId === group.id) voice.delete(s.id);
    // Połączenie, które oglądało tę grupę, zostaje bez kanału – klient sam wybierze inną grupę albo pokaże ekran powitalny.
    if (belongsToGroup(s.data.channel, group.id)) enterChannel(s, null);
  }
  broadcastVoice(group.id);
}

function groupSystemMessage(group, text) {
  const channel = groupChannel(group.id);
  io.to(`ch:${channel}`).emit('system', { text, time: Date.now(), channel });
}

// Ochrona kodów przed zgadywaniem: najwyżej 10 prób na 10 minut na konto (oprócz limitu na połączenie).
function joinAttemptLimited(accountId) {
  const now = Date.now();
  const recent = (joinAttempts.get(accountId) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (recent.length >= 10) {
    joinAttempts.set(accountId, recent);
    return true;
  }
  recent.push(now);
  joinAttempts.set(accountId, recent);
  return false;
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
  const channel = socket.data.channel;
  const group = groupOfChannel(channel);
  if (!group) return; // wiadomości istnieją tylko w kanałach grup
  const msg = {
    id: crypto.randomUUID(),
    senderId: socket.id,
    accountId: users.get(socket.id)?.accountId, // pozwala autorowi usunąć własną wiadomość
    channel,
    nick,
    time: Date.now(),
    ...extra,
  };
  // Klienci dostają opis oryginału (`replyTo`), a w magazynie zostaje samo `replyToId`.
  const [wire] = await attachReplies([msg]);
  io.to(`ch:${channel}`).emit('message', wire);
  // Powiadomienie o aktywności widzą tylko członkowie grupy, którzy oglądają inny kanał.
  io.to(`grp:${group.id}`).except(`ch:${channel}`).emit('activity', { channel });

  // Oznaczone osoby, które oglądają inny kanał, dostają osobne powiadomienie (czerwony licznik przy kanale).
  for (const mention of msg.mentions || []) {
    for (const [socketId, u] of users) {
      if (u.accountId !== mention.id) continue;
      const target = io.sockets.sockets.get(socketId);
      if (!target || target.rooms.has(`ch:${channel}`) || !target.rooms.has(`grp:${group.id}`)) continue;
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
    users.set(socket.id, { accountId: account.id, nick });

    // Kanał, w którym klient był ostatnio: tylko kanał grupy, do której należysz. Inaczej – pierwsza z Twoich grup,
    // a gdy nie masz żadnej, brak kanału (klient pokaże ekran powitalny z prośbą o dołączenie do grupy).
    const myGroups = groupsOf(account.id);
    myGroups.forEach((g) => socket.join(`grp:${g.id}`));
    let channel = payload.channel;
    const wantedGroup = groupOfChannel(channel);
    if (!wantedGroup || !isGroupMember(wantedGroup, account.id)) channel = myGroups.length ? groupChannel(myGroups[0].id) : null;
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
      groups: myGroups.map((g) => groupInfo(g, account.id)),
    });

    if (!alreadyIn) {
      if (channel) await sendHistory(socket, channel);
      myGroups.forEach((g) => socket.emit('voice:users', { groupId: g.id, users: voiceList(g.id) }));
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
    // zwykłe emoji do ok. 73 KB; animowane (GIF, animowany WebP, APNG) do 256 KB
    if (!isValidImageDataUrl(payload.image, EMOJI_STATIC_CHARS, EMOJI_GIF_BYTES, EMOJI_GIF_BYTES)) {
      return reply({ ok: false, error: 'Nieprawidłowy obraz emoji (animacja do 256 KB, zwykłe obrazy są zmniejszane).' });
    }

    const emoji = {
      id: crypto.randomBytes(6).toString('hex'),
      name,
      data: payload.image,
      v: mediaVersion(payload.image),
      animated: isAnimatedDataUrl(payload.image),
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
      // Reagować można tylko w kanale grupy, który oglądasz.
      if (!msg.channel || msg.channel !== socket.data.channel) return reply({ ok: false, error: 'Ta wiadomość jest w innym kanale.' });

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
    const group = groupOfChannel(payload && payload.channel);
    if (!group) return reply({ ok: false, error: 'Nie ma takiego kanału.' });
    if (!isGroupMember(group, user.accountId)) {
      return reply({ ok: false, error: 'Nie należysz do tej grupy.' });
    }
    if (rateLimited(socket, 'switch', 20, 10000)) {
      return reply({ ok: false, error: 'Zwolnij trochę – za szybko zmieniasz kanały.' });
    }

    const previous = socket.data.channel;
    if (previous) socket.to(`ch:${previous}`).emit('typing', { nick: user.nick, isTyping: false, channel: previous });
    enterChannel(socket, payload.channel);
    reply({ ok: true, channel: payload.channel });
    await sendHistory(socket, payload.channel);
  });

  // ---------- Grupy: tworzenie, dołączanie jednorazowym kodem, wychodzenie, usuwanie ----------
  const accountOf = () => {
    const user = users.get(socket.id);
    return user && accountsById.get(user.accountId);
  };

  socket.on('group:create', async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const account = accountOf();
    if (!account) return reply({ ok: false, error: 'Najpierw dołącz do czatu.' });
    if (rateLimited(socket, 'groupCreate', 5, 60000)) return reply({ ok: false, error: 'Zbyt wiele prób. Spróbuj za chwilę.' });

    const name = cleanText(payload && payload.name, MAX_GROUP_NAME);
    if (name.length < 2) return reply({ ok: false, error: 'Nazwa grupy musi mieć co najmniej 2 znaki.' });
    const mine = groupsOf(account.id);
    if (mine.filter((g) => g.ownerId === account.id).length >= MAX_GROUPS_OWNED) {
      return reply({ ok: false, error: `Możesz założyć najwyżej ${MAX_GROUPS_OWNED} grup.` });
    }
    if (mine.length >= MAX_GROUPS_JOINED) {
      return reply({ ok: false, error: `Możesz należeć najwyżej do ${MAX_GROUPS_JOINED} grup.` });
    }

    const group = { id: crypto.randomBytes(6).toString('hex'), name, ownerId: account.id, members: [account.id], code: null, createdAt: Date.now() };
    normalizeGroup(group);
    rotateGroupCode(group);
    indexGroup(group);
    await persistGroup(group);
    joinGroupRooms(account.id);
    pushGroups(account.id);
    reply({ ok: true, group: groupInfo(group, account.id) });
  });

  // Dołączenie kodem. Kod jest jednorazowy: po użyciu natychmiast wygasa, a twórca dostaje nowy.
  socket.on('group:join', async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const account = accountOf();
    if (!account) return reply({ ok: false, error: 'Najpierw dołącz do czatu.' });
    if (rateLimited(socket, 'groupJoin', 6, 60000) || joinAttemptLimited(account.id)) {
      return reply({ ok: false, error: 'Zbyt wiele prób wpisania kodu. Spróbuj ponownie za kilka minut.' });
    }

    const code = normalizeCode(payload && payload.code);
    const group = groupsById.get(groupsByCode.get(code));
    if (!group) return reply({ ok: false, error: 'Nieprawidłowy lub już zużyty kod.' });
    // Te sprawdzenia robimy PRZED zużyciem kodu – nieudana próba nie może go spalić.
    if (isGroupMember(group, account.id)) return reply({ ok: false, error: 'Już należysz do tej grupy.' });
    if (group.members.length >= MAX_GROUP_MEMBERS) return reply({ ok: false, error: 'Ta grupa jest już pełna.' });
    if (groupsOf(account.id).length >= MAX_GROUPS_JOINED) {
      return reply({ ok: false, error: `Możesz należeć najwyżej do ${MAX_GROUPS_JOINED} grup.` });
    }

    group.members.push(account.id);
    rotateGroupCode(group); // stary kod przestaje działać w tej samej chwili
    await persistGroup(group);

    joinGroupRooms(account.id);
    group.members.forEach(pushGroups); // wszyscy widzą nową liczbę osób, a twórca – nowy kod
    accountSockets(account.id).forEach((s) => s.emit('voice:users', { groupId: group.id, users: voiceList(group.id) }));
    broadcastUsers(); // nowy członek widzi, kto z grupy jest online (i vice versa)
    io.to(`grp:${group.id}`).emit('group:members-changed', { groupId: group.id });
    groupSystemMessage(group, `${account.nick} dołączył(a) do grupy`);
    reply({ ok: true, group: groupInfo(group, account.id) });
  });

  // Nowy kod na życzenie – tylko twórca (stary przestaje działać).
  socket.on('group:code', async (groupId, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const account = accountOf();
    const group = account && groupsById.get(groupId);
    if (!group || !isGroupMember(group, account.id)) return reply({ ok: false, error: 'Nie ma takiej grupy.' });
    // Domyślnie kody generuje tylko twórca; może to też zlecić roli z uprawnieniem „Kody dostępu”.
    if (!can(group, account.id, 'invite')) return reply({ ok: false, error: 'Nie masz uprawnienia do generowania kodów.' });
    if (rateLimited(socket, 'groupCode', 10, 60000)) return reply({ ok: false, error: 'Zwolnij trochę.' });
    rotateGroupCode(group);
    await persistGroup(group);
    group.members.forEach((id) => can(group, id, 'invite') && pushGroups(id)); // nowy kod widzą wszyscy uprawnieni
    reply({ ok: true, code: formatCode(group.code) });
  });

  // Wyjście z grupy (twórca nie może wyjść – może ją usunąć).
  socket.on('group:leave', async (groupId, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const account = accountOf();
    const group = account && groupsById.get(groupId);
    if (!group || !isGroupMember(group, account.id)) return reply({ ok: false, error: 'Nie należysz do tej grupy.' });
    if (group.ownerId === account.id) {
      return reply({ ok: false, error: 'Jesteś twórcą grupy – nie możesz z niej wyjść. Możesz ją usunąć.' });
    }
    group.members = group.members.filter((id) => id !== account.id);
    delete group.memberRoles[account.id];
    await persistGroup(group);
    await revokeGroupAccess(account.id, group);
    pushGroups(account.id);
    group.members.forEach(pushGroups);
    broadcastUsers();
    io.to(`grp:${group.id}`).emit('group:members-changed', { groupId: group.id });
    groupSystemMessage(group, `${account.nick} opuścił(a) grupę`);
    reply({ ok: true });
  });

  // Usunięcie grupy wraz z całą jej historią – tylko twórca.
  socket.on('group:delete', async (groupId, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const account = accountOf();
    const group = account && groupsById.get(groupId);
    if (!group) return reply({ ok: false, error: 'Nie ma takiej grupy.' });
    if (group.ownerId !== account.id) return reply({ ok: false, error: 'Grupę może usunąć tylko jej twórca.' });

    const members = group.members.slice();
    groupsById.delete(group.id);
    if (group.code) groupsByCode.delete(group.code);
    try {
      await store.deleteGroup(group.id);
      for (const c of group.channels) await store.removeChannelMessages(groupChannelId(group, c.id));
    } catch (err) {
      console.error('Błąd usuwania grupy:', err.message);
    }
    for (const accountId of members) {
      await revokeGroupAccess(accountId, group);
      pushGroups(accountId);
    }
    broadcastUsers();
    reply({ ok: true });
  });

  socket.on('group:members', (groupId, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const account = accountOf();
    const group = account && groupsById.get(groupId);
    if (!group || !isGroupMember(group, account.id)) return reply({ ok: false, error: 'Nie należysz do tej grupy.' });
    reply({
      ok: true,
      members: group.members
        .map((id) => accountsById.get(id))
        .filter(Boolean)
        .map((a) => ({
          id: a.id,
          nick: a.nick,
          avatar: mediaUrl(a, 'avatar'),
          status: a.status || 'online',
          statusText: a.statusText || '',
          nickColor: a.nickColor || null,
          nickFont: a.nickFont || null,
          isOwner: a.id === group.ownerId,
          roles: memberRoleIds(group, a.id),
        })),
    });
  });

  // ---------- Grupy: kanały, role i uprawnienia ----------
  // Sprawdza, że to członek grupy z wymaganym uprawnieniem. Zwraca { account, group } albo { error }.
  const groupFor = (groupId, perm) => {
    const account = accountOf();
    if (!account) return { error: 'Najpierw dołącz do czatu.' };
    const group = typeof groupId === 'string' ? groupsById.get(groupId) : null;
    if (!group || !isGroupMember(group, account.id)) return { error: 'Nie należysz do tej grupy.' };
    if (perm && !can(group, account.id, perm)) return { error: 'Nie masz do tego uprawnienia.' };
    return { account, group };
  };
  // Po każdej zmianie: zapis, świeże dane (z uprawnieniami dopasowanymi do każdej osoby) i odświeżenie listy członków.
  const refreshGroup = async (group) => {
    await persistGroup(group);
    group.members.forEach(pushGroups);
    broadcastUsers(); // zmiana składu grupy zmienia też to, kogo widzi online
    io.to(`grp:${group.id}`).emit('group:members-changed', { groupId: group.id });
  };
  // Uprawnienia, które możesz nadawać lub odbierać: tylko te, które sam masz (administrator i twórca – wszystkie).
  const grantable = (group, accountId, before, after) => {
    const mine = permsOf(group, accountId);
    const changed = [...before.filter((p) => !after.includes(p)), ...after.filter((p) => !before.includes(p))];
    return changed.every((p) => mine.has(p));
  };
  const adminLimited = () => rateLimited(socket, 'groupAdmin', 40, 60000);

  socket.on('group:rename', async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const ctx = groupFor(payload && payload.groupId, 'manageGroup');
    if (ctx.error) return reply({ ok: false, error: ctx.error });
    if (adminLimited()) return reply({ ok: false, error: 'Zwolnij trochę.' });
    const name = cleanText(payload.name, MAX_GROUP_NAME);
    if (name.length < 2) return reply({ ok: false, error: 'Nazwa grupy musi mieć co najmniej 2 znaki.' });
    ctx.group.name = name;
    await refreshGroup(ctx.group);
    reply({ ok: true });
  });

  // Obrazek grupy (jak avatar): zwykłe obrazy klient zmniejsza, GIF może być animowany. Wymaga „Zmiana nazwy grupy”.
  socket.on('group:icon', async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const ctx = groupFor(payload && payload.groupId, 'manageGroup');
    if (ctx.error) return reply({ ok: false, error: ctx.error });
    if (adminLimited()) return reply({ ok: false, error: 'Zwolnij trochę.' });
    const { group } = ctx;
    const icon = payload.icon;
    if (icon !== null && !validAvatar(icon)) {
      return reply({ ok: false, error: 'Nieprawidłowy obrazek grupy (GIF do 600 KB, inne formaty są zmniejszane).' });
    }
    // Łączny budżet pamięci na obrazki grup (chroni serwer przed wieloma dużymi GIF-ami).
    if (icon) {
      let total = 0;
      for (const g of groupsById.values()) if (g !== group && g.icon) total += g.icon.length;
      if (total + icon.length > MAX_MEDIA_BYTES * 0.5) return reply({ ok: false, error: 'Serwer wyczerpał limit miejsca na obrazki grup.' });
    }
    group.icon = icon;
    group.iconV = mediaVersion(icon);
    await refreshGroup(group);
    reply({ ok: true });
  });

  // -- kanały --
  socket.on('group:channel:create', async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const ctx = groupFor(payload && payload.groupId, 'manageChannels');
    if (ctx.error) return reply({ ok: false, error: ctx.error });
    if (adminLimited()) return reply({ ok: false, error: 'Zwolnij trochę.' });
    const { group } = ctx;
    const name = cleanChannelName(payload.name);
    if (!name) return reply({ ok: false, error: 'Podaj nazwę kanału.' });
    if (group.channels.length >= MAX_GROUP_CHANNELS) {
      return reply({ ok: false, error: `Grupa może mieć najwyżej ${MAX_GROUP_CHANNELS} kanałów.` });
    }
    if (group.channels.some((c) => c.name === name)) return reply({ ok: false, error: 'Kanał o takiej nazwie już istnieje.' });
    let id;
    do id = crypto.randomBytes(3).toString('hex');
    while (group.channels.some((c) => c.id === id));
    group.channels.push({ id, name });
    await refreshGroup(group);
    reply({ ok: true, channel: groupChannelId(group, id) });
  });

  socket.on('group:channel:rename', async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const ctx = groupFor(payload && payload.groupId, 'manageChannels');
    if (ctx.error) return reply({ ok: false, error: ctx.error });
    if (adminLimited()) return reply({ ok: false, error: 'Zwolnij trochę.' });
    const { group } = ctx;
    const entry = group.channels.find((c) => groupChannelId(group, c.id) === payload.channel);
    const name = cleanChannelName(payload.name);
    if (!entry) return reply({ ok: false, error: 'Nie ma takiego kanału.' });
    if (!name) return reply({ ok: false, error: 'Podaj nazwę kanału.' });
    if (group.channels.some((c) => c !== entry && c.name === name)) return reply({ ok: false, error: 'Kanał o takiej nazwie już istnieje.' });
    entry.name = name;
    await refreshGroup(group);
    reply({ ok: true });
  });

  socket.on('group:channel:delete', async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const ctx = groupFor(payload && payload.groupId, 'manageChannels');
    if (ctx.error) return reply({ ok: false, error: ctx.error });
    if (adminLimited()) return reply({ ok: false, error: 'Zwolnij trochę.' });
    const { group } = ctx;
    const entry = group.channels.find((c) => groupChannelId(group, c.id) === payload.channel);
    if (!entry) return reply({ ok: false, error: 'Nie ma takiego kanału.' });
    if (!entry.id) return reply({ ok: false, error: 'Kanału głównego nie można usunąć.' });
    const channel = groupChannelId(group, entry.id);
    const fallback = groupChannel(group.id);
    group.channels = group.channels.filter((c) => c !== entry);
    try {
      await store.removeChannelMessages(channel); // razem z plikami
    } catch (err) {
      console.error('Błąd usuwania kanału:', err.message);
    }
    io.to(`grp:${group.id}`).emit('group:channel-removed', { groupId: group.id, channel });
    for (const s of await io.in(`ch:${channel}`).fetchSockets()) {
      const live = io.sockets.sockets.get(s.id);
      if (!live) continue;
      enterChannel(live, fallback);
      await sendHistory(live, fallback);
    }
    await refreshGroup(group);
    reply({ ok: true });
  });

  // -- role --
  // Rolę wolno ruszać, gdy stoi poniżej Twojej najwyższej roli (twórca może wszystkie).
  const manageable = (group, accountId, idx) => idx !== -1 && topRank(group, accountId) < idx;

  socket.on('group:role:create', async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const ctx = groupFor(payload && payload.groupId, 'manageRoles');
    if (ctx.error) return reply({ ok: false, error: ctx.error });
    if (adminLimited()) return reply({ ok: false, error: 'Zwolnij trochę.' });
    const { account, group } = ctx;
    const name = cleanText(payload.name, MAX_ROLE_NAME);
    if (!name) return reply({ ok: false, error: 'Podaj nazwę roli.' });
    if (group.roles.length >= MAX_ROLES) return reply({ ok: false, error: `Grupa może mieć najwyżej ${MAX_ROLES} ról.` });
    const perms = cleanPerms(payload.perms);
    if (!grantable(group, account.id, [], perms)) return reply({ ok: false, error: 'Nie możesz nadać uprawnień, których sam nie masz.' });
    let id;
    do id = crypto.randomBytes(3).toString('hex');
    while (roleIndex(group, id) !== -1);
    group.roles.push({ id, name, color: cleanColor(payload.color), perms }); // nowa rola trafia na sam dół hierarchii
    await refreshGroup(group);
    reply({ ok: true, roleId: id });
  });

  socket.on('group:role:update', async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const ctx = groupFor(payload && payload.groupId, 'manageRoles');
    if (ctx.error) return reply({ ok: false, error: ctx.error });
    if (adminLimited()) return reply({ ok: false, error: 'Zwolnij trochę.' });
    const { account, group } = ctx;

    if (payload.roleId === 'everyone') {
      const perms = cleanPerms(payload.perms, { allowAdmin: false });
      if (!grantable(group, account.id, group.everyone, perms)) return reply({ ok: false, error: 'Nie możesz zmieniać uprawnień, których sam nie masz.' });
      group.everyone = perms;
    } else {
      const idx = roleIndex(group, payload.roleId);
      if (idx === -1) return reply({ ok: false, error: 'Nie ma takiej roli.' });
      if (!manageable(group, account.id, idx)) return reply({ ok: false, error: 'Ta rola jest wyżej lub na równi z Twoją najwyższą.' });
      const role = group.roles[idx];
      if (payload.name !== undefined) {
        const name = cleanText(payload.name, MAX_ROLE_NAME);
        if (!name) return reply({ ok: false, error: 'Podaj nazwę roli.' });
        role.name = name;
      }
      if (payload.color !== undefined) role.color = cleanColor(payload.color);
      if (payload.perms !== undefined) {
        const perms = cleanPerms(payload.perms);
        if (!grantable(group, account.id, role.perms, perms)) return reply({ ok: false, error: 'Nie możesz zmieniać uprawnień, których sam nie masz.' });
        role.perms = perms;
      }
    }
    await refreshGroup(group);
    reply({ ok: true });
  });

  socket.on('group:role:move', async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const ctx = groupFor(payload && payload.groupId, 'manageRoles');
    if (ctx.error) return reply({ ok: false, error: ctx.error });
    if (adminLimited()) return reply({ ok: false, error: 'Zwolnij trochę.' });
    const { account, group } = ctx;
    const idx = roleIndex(group, payload.roleId);
    const target = idx + (payload.dir === -1 ? -1 : 1);
    if (!manageable(group, account.id, idx)) return reply({ ok: false, error: 'Ta rola jest wyżej lub na równi z Twoją najwyższą.' });
    // nie wolno przesunąć roli na pozycję swojej najwyższej roli ani wyżej
    if (target < 0 || target >= group.roles.length || !manageable(group, account.id, target)) {
      return reply({ ok: false, error: 'Nie można przesunąć roli w tę stronę.' });
    }
    [group.roles[idx], group.roles[target]] = [group.roles[target], group.roles[idx]];
    await refreshGroup(group);
    reply({ ok: true });
  });

  socket.on('group:role:delete', async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const ctx = groupFor(payload && payload.groupId, 'manageRoles');
    if (ctx.error) return reply({ ok: false, error: ctx.error });
    if (adminLimited()) return reply({ ok: false, error: 'Zwolnij trochę.' });
    const { account, group } = ctx;
    const idx = roleIndex(group, payload.roleId);
    if (!manageable(group, account.id, idx)) return reply({ ok: false, error: 'Nie możesz usunąć tej roli.' });
    const [removed] = group.roles.splice(idx, 1);
    for (const id of Object.keys(group.memberRoles)) {
      group.memberRoles[id] = group.memberRoles[id].filter((r) => r !== removed.id);
      if (!group.memberRoles[id].length) delete group.memberRoles[id];
    }
    await refreshGroup(group);
    reply({ ok: true });
  });

  // Ustawia pełną listę ról członka. Zmienić można tylko role stojące niżej od Twojej najwyższej,
  // i tylko u osób stojących niżej (albo u siebie).
  socket.on('group:member:roles', async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const ctx = groupFor(payload && payload.groupId, 'manageRoles');
    if (ctx.error) return reply({ ok: false, error: ctx.error });
    if (adminLimited()) return reply({ ok: false, error: 'Zwolnij trochę.' });
    const { account, group } = ctx;
    const targetId = payload.accountId;
    if (!isGroupMember(group, targetId)) return reply({ ok: false, error: 'Tej osoby nie ma w grupie.' });
    if (targetId === group.ownerId) return reply({ ok: false, error: 'Nie można zmieniać ról twórcy grupy.' });
    if (targetId !== account.id && !(topRank(group, account.id) < topRank(group, targetId))) {
      return reply({ ok: false, error: 'Ta osoba ma rolę wyżej lub na równi z Twoją.' });
    }
    const before = memberRoleIds(group, targetId);
    const after = Array.from(new Set(Array.isArray(payload.roles) ? payload.roles : [])).filter((id) => roleIndex(group, id) !== -1);
    if (after.length > MAX_ROLES_PER_MEMBER) return reply({ ok: false, error: `Jedna osoba może mieć najwyżej ${MAX_ROLES_PER_MEMBER} ról.` });
    const changed = [...before.filter((r) => !after.includes(r)), ...after.filter((r) => !before.includes(r))];
    if (!changed.every((id) => manageable(group, account.id, roleIndex(group, id)))) {
      return reply({ ok: false, error: 'Możesz zmieniać tylko role stojące niżej od Twojej najwyższej.' });
    }
    if (after.length) group.memberRoles[targetId] = after;
    else delete group.memberRoles[targetId];
    await refreshGroup(group);
    reply({ ok: true });
  });

  socket.on('group:kick', async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const ctx = groupFor(payload && payload.groupId, 'kick');
    if (ctx.error) return reply({ ok: false, error: ctx.error });
    if (adminLimited()) return reply({ ok: false, error: 'Zwolnij trochę.' });
    const { account, group } = ctx;
    const targetId = payload.accountId;
    const target = accountsById.get(targetId);
    if (!target || !isGroupMember(group, targetId)) return reply({ ok: false, error: 'Tej osoby nie ma w grupie.' });
    if (targetId === account.id) return reply({ ok: false, error: 'Nie możesz wyrzucić samego siebie – użyj „Opuść”.' });
    if (targetId === group.ownerId || !(topRank(group, account.id) < topRank(group, targetId))) {
      return reply({ ok: false, error: 'Ta osoba ma rolę wyżej lub na równi z Twoją.' });
    }
    group.members = group.members.filter((id) => id !== targetId);
    delete group.memberRoles[targetId];
    await revokeGroupAccess(targetId, group);
    pushGroups(targetId);
    groupSystemMessage(group, `${target.nick} został(a) usunięty(-a) z grupy`);
    await refreshGroup(group);
    reply({ ok: true });
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
    broadcastUsers();
    broadcastAllVoice();
  });

  // ---------- Czat głosowy: serwer tylko pośredniczy w wymianie sygnałów WebRTC ----------
  // Każda grupa ma własny kanał głosowy; osoba może być naraz tylko na jednym.
  socket.on('voice:join', (groupId, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const user = users.get(socket.id);
    if (!user) return reply({ ok: false, error: 'Najpierw dołącz do czatu.' });
    const group = typeof groupId === 'string' ? groupsById.get(groupId) : null;
    if (!group || !isGroupMember(group, user.accountId)) return reply({ ok: false, error: 'Nie należysz do tej grupy.' });
    const current = voice.get(socket.id);
    if (current && current.groupId !== group.id) leaveVoice(socket); // przenosiny do kanału innej grupy
    if (!voice.has(socket.id) && voiceList(group.id).length >= MAX_VOICE_USERS) {
      return reply({ ok: false, error: `Kanał głosowy jest pełny (maksymalnie ${MAX_VOICE_USERS} osób).` });
    }
    // Osoba dołączająca sama zainicjuje połączenia z tymi, którzy już są na kanale tej grupy.
    const peers = Array.from(voice.entries())
      .filter(([id, s]) => id !== socket.id && s.groupId === group.id && users.has(id))
      .map(([id]) => id);
    voice.set(socket.id, { groupId: group.id, muted: false, deafened: false, sharing: false });
    reply({ ok: true, peers });
    broadcastVoice(group.id);
  });

  socket.on('voice:leave', () => leaveVoice(socket));

  socket.on('voice:state', (state) => {
    const entry = voice.get(socket.id);
    if (!entry || !state) return;
    entry.muted = Boolean(state.muted);
    entry.deafened = Boolean(state.deafened);
    entry.sharing = Boolean(state.sharing);
    broadcastVoice(entry.groupId);
  });

  socket.on('voice:signal', (payload) => {
    const mine = voice.get(socket.id);
    if (!mine || !payload) return;
    const { to, data } = payload;
    // sygnały krążą tylko między osobami z kanału głosowego tej samej grupy
    if (typeof to !== 'string' || to === socket.id || !voice.has(to) || voice.get(to).groupId !== mine.groupId) return;
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
      // Cudze wiadomości w grupie może usuwać osoba z uprawnieniem „Zarządzanie wiadomościami” (jak moderator na Discordzie).
      const msgGroup = groupOfChannel(msg.channel);
      const moderator = Boolean(msgGroup) && isGroupMember(msgGroup, user.accountId) && can(msgGroup, user.accountId, 'manageMessages');
      if (!owner && !moderator) return reply({ ok: false, error: 'Możesz usuwać tylko własne wiadomości.' });
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
      // Pliki są dostępne tylko dla członków grupy, w której je wysłano (stare pliki spoza grup – dla nikogo).
      const meta = await store.get(id);
      const fileGroup = meta && groupOfChannel(meta.channel);
      if (meta && (!fileGroup || !isGroupMember(fileGroup, users.get(socket.id).accountId))) {
        return reply({ ok: false, error: 'Ten plik jest dostępny tylko dla członków grupy.' });
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
    if (!mayPost(socket)) return socket.emit('group:denied', { error: NO_POST_ERROR });
    if (rateLimited(socket, 'msg', 10, 10000)) return;

    const extra = { kind: 'text', text };
    const group = groupOfChannel(socket.data.channel);
    // W grupie można oznaczać (i powiadamiać) tylko jej członków.
    const mentions = parseMentions(text).filter((m) => !group || isGroupMember(group, m.id));

    if (typeof body.replyTo === 'string' && body.replyTo.length <= 64) {
      const original = await store.get(body.replyTo).catch(() => null);
      // Odpowiedzieć można tylko na wiadomość z tego samego kanału; w przeciwnym razie wysyłamy zwykłą wiadomość.
      if (original && original.channel && original.channel === socket.data.channel) {
        extra.replyToId = original.id;
        const author = original.accountId && accountsById.get(original.accountId);
        // Odpowiedź domyślnie powiadamia autora oryginału (jak „@WŁ.” na Discordzie), chyba że to my.
        if (
          body.ping !== false &&
          author &&
          author.id !== user.accountId &&
          (!group || isGroupMember(group, author.id)) &&
          !mentions.some((m) => m.id === author.id)
        ) {
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
    // W grupie podpowiadamy tylko jej członków (reszta kont nie powinna się w ogóle ujawniać).
    const searchGroup = groupOfChannel(socket.data.channel);
    const pool = searchGroup ? searchGroup.members.map((id) => accountsById.get(id)).filter(Boolean) : [];
    for (const account of pool) {
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
    if (!mayPost(socket)) return reply({ ok: false, error: NO_POST_ERROR });
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
    if (!mayPost(socket)) return reply({ ok: false, error: NO_POST_ERROR });

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

  socket.on('party:start', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const user = users.get(socket.id);
    const channel = socket.data.channel;
    if (!user || !channel || !mayPost(socket)) return reply({ ok: false, error: NO_POST_ERROR });
    if (rateLimited(socket, 'party', 5, 30000)) return reply({ ok: false, error: 'Zwolnij trochę.' });
    const href = payload && typeof payload.href === 'string' ? payload.href.trim() : '';
    if (!/^https?:\/\/\S{4,490}$/i.test(href)) return reply({ ok: false, error: 'To nie wygląda na link do filmu.' });
    const existing = parties.get(channel);
    if (existing && existing.hostId !== user.accountId) {
      return reply({ ok: false, error: `${existing.hostNick} już zaprasza do oglądania – dołącz do niego.` });
    }
    if (socket.data.party && socket.data.party !== channel) leaveParty(socket);
    parties.set(channel, {
      id: crypto.randomBytes(6).toString('hex'),
      href,
      hostId: user.accountId,
      hostNick: user.nick,
      viewers: new Map([[user.accountId, user.nick]]),
      started: false,
    });
    socket.data.party = channel;
    io.to(`ch:${channel}`).emit('system', { text: `${user.nick} zaprasza do wspólnego oglądania.`, time: Date.now(), channel });
    broadcastParty(channel);
    reply({ ok: true });
  });

  socket.on('party:join', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const user = users.get(socket.id);
    const channel = socket.data.channel;
    const group = groupOfChannel(channel);
    const p = channel && parties.get(channel);
    if (!user || !group || !isGroupMember(group, user.accountId)) return reply({ ok: false });
    if (!p) return reply({ ok: false, error: 'Oglądanie już się skończyło.' });
    p.viewers.set(user.accountId, user.nick);
    socket.data.party = channel;
    broadcastParty(channel);
    reply({ ok: true, party: publicParty(channel) });
  });

  socket.on('party:leave', () => leaveParty(socket));

  // Tylko gospodarz: odliczanie 3-2-1. Serwer podaje czas do startu, więc zegary klientów nie muszą się zgadzać.
  socket.on('party:go', () => {
    const user = users.get(socket.id);
    const channel = socket.data.channel;
    const p = channel && parties.get(channel);
    if (!user || !p || p.hostId !== user.accountId) return;
    if (rateLimited(socket, 'partygo', 6, 60000)) return;
    p.started = true;
    io.to(`ch:${channel}`).emit('party:countdown', { channel, id: p.id, inMs: 4000 });
    broadcastParty(channel);
  });

  socket.on('party:react', (emoji) => {
    const user = users.get(socket.id);
    const channel = socket.data.channel;
    const p = channel && parties.get(channel);
    if (!user || !p || !p.viewers.has(user.accountId) || !PARTY_EMOJI.includes(emoji)) return;
    if (rateLimited(socket, 'preact', 20, 5000)) return;
    io.to(`ch:${channel}`).emit('party:react', { channel, nick: user.nick, emoji });
  });

  socket.on('typing', (isTyping) => {
    const user = users.get(socket.id);
    if (!user) return;
    const channel = socket.data.channel;
    if (!channel) return;
    socket.to(`ch:${channel}`).emit('typing', { nick: user.nick, isTyping: Boolean(isTyping), channel });
  });

  socket.on('disconnect', () => {
    leaveParty(socket);
    const voiceEntry = voice.get(socket.id);
    voice.delete(socket.id);
    const user = users.get(socket.id);
    if (!user) return;
    users.delete(socket.id);
    const channel = socket.data.channel;
    if (channel && !isOnline(user.accountId)) {
      socket.to(`ch:${channel}`).emit('typing', { nick: user.nick, isTyping: false, channel });
    }
    broadcastUsers();
    if (voiceEntry) broadcastVoice(voiceEntry.groupId);
  });
});

async function start() {
  await store.init();
  console.log(`Historia: ${store.label}, wiadomości i pliki usuwane po ${RETENTION_DAYS} dn.`);
  if (!DATA_IS_PERSISTENT) {
    console.warn(
      'UWAGA: brak MONGODB_URI – konta, wiadomości i emoji znikną przy każdym wdrożeniu i uśpieniu serwera. ' +
        'Ustaw MONGODB_URI (np. darmowy MongoDB Atlas), żeby je zachować.'
    );
  }

  for (const emoji of await store.loadEmoji()) emojiById.set(emoji.id, emoji);
  console.log(`Wczytano emoji: ${emojiById.size}`);

  for (const group of await store.loadGroups()) indexGroup(group);
  console.log(`Wczytano grup: ${groupsById.size}`);

  // Dawne kanały wspólne dla wszystkich już nie istnieją – czyścimy ich resztki (wiadomości i pliki).
  for (const old of ['ogolny', 'ogolny2', 'screeny', 'granie', 'nsfw']) {
    await store.removeChannelMessages(old).catch((err) => console.error('Nie udało się wyczyścić starego kanału:', err.message));
  }

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
