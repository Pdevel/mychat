// Połączenie z serwerem, z którego została załadowana strona (działa lokalnie i na Renderze).
const socket = io();

const $ = (id) => document.getElementById(id);
const loginScreen = $('login-screen');
const chatScreen = $('chat-screen');
const loginForm = $('login-form');
const nickInput = $('nick-input');
const loginError = $('login-error');
const loginAvatarEl = $('login-avatar');
const avatarFileInput = $('avatar-file');
const messagesEl = $('messages');
const messageForm = $('message-form');
const messageInput = $('message-input');
const typingEl = $('typing');
const statusEl = $('status');
const onlineEl = $('online-count');
const membersTitleEl = $('members-title');
const membersListEl = $('members-list');
const meAvatarEl = $('me-avatar');
const meNameEl = $('me-name');
const fileInput = $('file-input');
const emojiPanel = $('emoji-panel');
const gifPanel = $('gif-panel');
const gifSearch = $('gif-search');
const gifGrid = $('gif-grid');
const gifHint = $('gif-hint');
const gifUrlInput = $('gif-url');
const settingsModal = $('settings');
const lightbox = $('lightbox');
const dropOverlay = $('drop-overlay');

const GROUP_WINDOW_MS = 5 * 60 * 1000; // wiadomości tej samej osoby w 5 min są grupowane
let maxFileBytes = 5 * 1024 * 1024;
let gifSearchEnabled = false;
let retentionMs = 7 * 24 * 60 * 60 * 1000;
let retentionDays = 7;

// ---------- Zapis ustawień w przeglądarce ----------
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* tryb prywatny – pomijamy */
    }
  },
};

const THEMES = [
  { id: 'dark', name: 'Ciemny', colors: ['#1e1f22', '#2b2d31', '#313338'] },
  { id: 'light', name: 'Jasny', colors: ['#e3e5e8', '#f2f3f5', '#ffffff'] },
  { id: 'midnight', name: 'Północ (AMOLED)', colors: ['#000000', '#0a0a0c', '#17171a'] },
  { id: 'forest', name: 'Las', colors: ['#121b16', '#19261f', '#1f2f26'] },
  { id: 'sunset', name: 'Zachód słońca', colors: ['#1d1424', '#2a1b33', '#33213e'] },
];
const ACCENTS = ['#5865f2', '#3ba55d', '#eb459e', '#ed4245', '#faa61a', '#1abc9c', '#9b59b6'];

let settings = store.get('mychat.settings', {
  theme: 'dark',
  accent: '#5865f2',
  sound: true,
  archive: true, // zapisuj wiadomości na tym urządzeniu (nie znikają po okresie przechowywania na serwerze)
  archiveFiles: false, // zapisuj też zawartość plików (zajmuje więcej miejsca)
});
// avatar = adres obrazu z serwera; avatarData = mała lokalna kopia (pozwala odtworzyć avatar po zresetowaniu serwera)
let profile = store.get('mychat.profile', { nick: '', avatar: null, avatarData: null });
if (profile.avatar && profile.avatar.startsWith('data:')) {
  // starszy format: avatar był zapisany jako data-URL
  profile.avatarData = profile.avatarData || profile.avatar;
  profile.avatar = null;
}

let myNick = null;
let myAccountId = null;

// Kanały tekstowe
const DEFAULT_CHANNEL = 'ogolny';
let channels = [{ id: DEFAULT_CHANNEL, name: 'ogólny' }]; // pełna lista przychodzi z serwera po zalogowaniu
let currentChannel = store.get('mychat.channel', { id: DEFAULT_CHANNEL }).id;
let adultConfirmed = store.get('mychat.adult', { ok: false }).ok === true; // potwierdzenie pełnoletności (nsfw)
const unreadChannels = new Set(); // kanały z nowymi wiadomościami, których nie oglądasz
let pendingAvatar = profile.avatarData; // avatar wybrany na ekranie logowania (data-URL)
let avatarTarget = 'login';
let lastNick = null;
let lastDay = null;
let lastMessageTime = 0;
let typingTimeout = null;
let unread = 0;
const typingUsers = new Set();
const avatars = new Map(); // nick -> data-URL (lub null)

// ---------- Pomocnicze ----------
const COLORS = ['#5865f2', '#3ba55d', '#faa61a', '#eb459e', '#ed4245', '#1abc9c', '#9b59b6', '#e67e22'];

function colorFor(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

// ---------- Styl nicku (kolor i czcionka) ----------
// Krój i rozmiar dobrane tak, żeby różne czcionki wyglądały w tym samym wierszu równo.
const NICK_FONTS = [
  { id: 'default', name: 'Domyślna', family: '' },
  { id: 'pacifico', name: 'Pacifico', family: "'Pacifico', cursive", scale: 0.95 },
  { id: 'lobster', name: 'Lobster', family: "'Lobster', cursive", scale: 1.05 },
  { id: 'caveat', name: 'Caveat', family: "'Caveat', cursive", scale: 1.25, weight: 600 },
  { id: 'orbitron', name: 'Orbitron', family: "'Orbitron', sans-serif", scale: 0.9, weight: 700 },
  { id: 'pixel', name: 'Pixel', family: "'Press Start 2P', monospace", scale: 0.7 },
  { id: 'bebas', name: 'Bebas Neue', family: "'Bebas Neue', sans-serif", scale: 1.15 },
  { id: 'playfair', name: 'Playfair', family: "'Playfair Display', serif", scale: 1, weight: 700 },
  { id: 'fredoka', name: 'Fredoka', family: "'Fredoka', sans-serif", scale: 1.05, weight: 600 },
  { id: 'typewriter', name: 'Maszyna', family: "'Special Elite', monospace", scale: 1 },
  { id: 'creepster', name: 'Creepster', family: "'Creepster', cursive", scale: 1.15 },
  { id: 'mono', name: 'Mono', family: "'Roboto Mono', monospace", scale: 0.95, weight: 600 },
];
const NICK_COLORS = ['#ff6b6b', '#ff9f43', '#feca57', '#1dd1a1', '#48dbfb', '#54a0ff', '#a29bfe', '#ff6bcb', '#ffffff', '#b2bec3'];

// Style osób znanych z listy online, historii i profili: accountId -> { color, font }.
// Zapamiętujemy je lokalnie, żeby stare wiadomości z archiwum miały właściwy wygląd, nawet gdy autora nie ma online.
const nickStyles = new Map(Object.entries(store.get('mychat.nickstyles', {}).map || {}));
const nickStylesByNick = new Map(); // zapas dla wiadomości bez konta (sprzed wprowadzenia kont)
let nickStylesSaveTimer = null;

function setNickStyle(accountId, nick, raw) {
  const style = { color: raw.nickColor || null, font: raw.nickFont || null };
  const same = (s) => s && s.color === style.color && s.font === style.font;
  let changed = false;
  if (accountId) {
    if (style.color || style.font) {
      if (!same(nickStyles.get(accountId))) {
        nickStyles.set(accountId, style);
        changed = true;
      }
    } else if (nickStyles.delete(accountId)) {
      changed = true;
    }
  }
  if (nick) nickStylesByNick.set(nick, style);
  if (changed && !nickStylesSaveTimer) {
    nickStylesSaveTimer = setTimeout(() => {
      nickStylesSaveTimer = null;
      store.set('mychat.nickstyles', { map: Object.fromEntries(Array.from(nickStyles).slice(-300)) });
    }, 1000);
  }
  return changed;
}

// Nakłada styl na element z nickiem. `fallbackColor` – kolor, gdy osoba nie ustawiła własnego.
function styleNick(node, nick, style, fallbackColor) {
  const font = NICK_FONTS.find((f) => f.id === (style && style.font));
  node.style.color = (style && style.color) || fallbackColor || '';
  node.style.fontFamily = font && font.family ? font.family : '';
  node.style.fontSize = font && font.scale ? `${font.scale}em` : '';
  node.style.fontWeight = font && font.weight ? String(font.weight) : '';
}

function applyNickStyle(node, nick, accountId) {
  const style = (accountId && nickStyles.get(accountId)) || nickStylesByNick.get(nick) || null;
  styleNick(node, nick, style, colorFor(nick));
  node.classList.add('nick-styled');
  node.dataset.nick = nick;
  if (accountId) node.dataset.account = accountId;
}

// Po zmianie czyjegoś stylu odświeżamy wszystkie jego nicki widoczne na ekranie.
function refreshNickStyles() {
  document.querySelectorAll('.nick-styled').forEach((n) => applyNickStyle(n, n.dataset.nick, n.dataset.account));
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // textContent = ochrona przed XSS
  return node;
}

function toast(text, info = false) {
  const t = el('div', 'toast' + (info ? ' toast--info' : ''), text);
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 3600);
}

function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 140;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------- Motywy ----------
function applySettings() {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.style.setProperty('--accent', settings.accent);
  const bg = THEMES.find((t) => t.id === settings.theme)?.colors[2] || '#313338';
  document.querySelector('meta[name="theme-color"]').setAttribute('content', bg);
  store.set('mychat.settings', settings);
  renderSettingsOptions();
}

function renderSettingsOptions() {
  $('theme-grid').replaceChildren(
    ...THEMES.map((t) => {
      const card = el('button', 'theme-card' + (t.id === settings.theme ? ' is-selected' : ''));
      card.type = 'button';
      const preview = el('div', 'theme-card__preview');
      t.colors.forEach((c) => {
        const i = el('i');
        i.style.background = c;
        preview.appendChild(i);
      });
      card.append(preview, el('span', '', t.name));
      card.addEventListener('click', () => {
        settings.theme = t.id;
        applySettings();
      });
      return card;
    })
  );

  const swatches = ACCENTS.map((c) => {
    const s = el('button', 'swatch' + (c === settings.accent ? ' is-selected' : ''));
    s.type = 'button';
    s.style.background = c;
    s.setAttribute('aria-label', `Kolor ${c}`);
    s.addEventListener('click', () => {
      settings.accent = c;
      applySettings();
    });
    return s;
  });
  const custom = el('input', 'swatch-custom');
  custom.type = 'color';
  custom.value = settings.accent;
  custom.title = 'Własny kolor';
  custom.addEventListener('input', () => {
    settings.accent = custom.value;
    document.documentElement.style.setProperty('--accent', settings.accent);
    store.set('mychat.settings', settings);
  });
  $('accent-row').replaceChildren(...swatches, custom);

  $('sound-toggle').checked = settings.sound;
  $('archive-toggle').checked = settings.archive;
  $('archive-files-toggle').checked = settings.archiveFiles;
  $('archive-files-toggle').disabled = !settings.archive;
}

// ---------- Avatary ----------
// Dozwolone źródła obrazu: adres z serwera (/media/…) albo data-URL wybrany lokalnie (także animowany GIF).
const MEDIA_URL = /^\/media\/(avatar|banner)\/[0-9a-f-]{36}\?v=[0-9a-f]+$/;
const DATA_IMAGE_PREFIX = /^data:image\/(jpeg|png|webp|gif);base64,/;
function isSafeImageSrc(value) {
  return (
    typeof value === 'string' &&
    (MEDIA_URL.test(value) ||
      value.startsWith(`blob:${location.origin}/`) || // lokalny podgląd wybranego pliku
      (DATA_IMAGE_PREFIX.test(value) && !value.includes('"')))
  );
}

// Animowane GIF-y wysyłamy w oryginale, więc mają osobne (większe) limity niż zwykłe obrazy.
let gifAvatarBytes = 600 * 1024;
let gifBannerBytes = 1536 * 1024;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Nie udało się odczytać pliku.'));
    reader.readAsDataURL(file);
  });
}

function setAvatarVisual(node, nick, avatar) {
  if (isSafeImageSrc(avatar)) {
    node.style.backgroundImage = `url("${avatar}")`;
    node.style.backgroundColor = '';
    node.textContent = '';
  } else {
    node.style.backgroundImage = 'none';
    node.style.backgroundColor = nick ? colorFor(nick) : '';
    node.textContent = nick ? nick.charAt(0).toUpperCase() : '';
  }
}

function makeAvatar(nick, extraClass) {
  const a = el('div', 'avatar' + (extraClass ? ' ' + extraClass : ''));
  a.dataset.nick = nick;
  setAvatarVisual(a, nick, avatars.get(nick));
  return a;
}

function refreshAvatars() {
  document.querySelectorAll('.avatar[data-nick]').forEach((node) => {
    setAvatarVisual(node, node.dataset.nick, avatars.get(node.dataset.nick));
  });
}

function fileToAvatar(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) return reject(new Error('To nie jest obrazek.'));
    if (file.type === 'image/gif') {
      // GIF zostaje bez zmian, żeby nie stracić animacji
      if (file.size > gifAvatarBytes) {
        return reject(new Error(`Animowany avatar (GIF) może mieć maksymalnie ${formatSize(gifAvatarBytes)}.`));
      }
      return readAsDataUrl(file).then(resolve, reject);
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const size = 128;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const side = Math.min(img.width, img.height);
      canvas.getContext('2d').drawImage(
        img,
        (img.width - side) / 2,
        (img.height - side) / 2,
        side,
        side,
        0,
        0,
        size,
        size
      );
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Nie udało się wczytać obrazka.'));
    };
    img.src = url;
  });
}

function updateLoginAvatar() {
  setAvatarVisual(loginAvatarEl, nickInput.value.trim(), pendingAvatar);
}

// Kopię avatara w localStorage trzymamy tylko, gdy jest mała (duże GIF-y zostają wyłącznie na serwerze).
const smallData = (dataUrl) => (dataUrl && dataUrl.length <= 60000 ? dataUrl : null);

function setMyAvatar(avatar) {
  profile.avatar = avatar; // pokazujemy od razu, zanim serwer odpowie
  profile.avatarData = smallData(avatar);
  store.set('mychat.profile', profile);
  avatars.set(myNick, avatar);
  refreshAvatars();
  updateProfilePreview();
  socket.timeout(20000).emit('avatar', avatar, (err, res) => {
    if (err || !res || !res.ok) return toast((res && res.error) || 'Nie udało się zapisać avatara.');
    backup.save({ avatar, avatarUrl: res.avatar || null }); // pełny obraz (także GIF) trafia do kopii zapasowej
    // Od teraz używamy adresu z serwera (jak wszyscy inni) zamiast ciężkiego data-URL.
    profile.avatar = res.avatar || null;
    store.set('mychat.profile', profile);
    avatars.set(myNick, profile.avatar);
    refreshAvatars();
    updateProfilePreview();
  });
}

loginAvatarEl.addEventListener('click', () => {
  avatarTarget = 'login';
  avatarFileInput.click();
});
$('avatar-change').addEventListener('click', () => {
  avatarTarget = 'settings';
  avatarFileInput.click();
});
$('avatar-remove').addEventListener('click', () => setMyAvatar(null));

avatarFileInput.addEventListener('change', async () => {
  const file = avatarFileInput.files[0];
  avatarFileInput.value = '';
  if (!file) return;
  try {
    const dataUrl = await fileToAvatar(file);
    if (avatarTarget === 'login') {
      pendingAvatar = dataUrl;
      updateLoginAvatar();
    } else {
      setMyAvatar(dataUrl);
    }
  } catch (err) {
    toast(err.message);
  }
});

nickInput.addEventListener('input', updateLoginAvatar);

// ---------- Renderowanie wiadomości ----------
function linkify(text) {
  const frag = document.createDocumentFragment();
  text.split(/(https?:\/\/[^\s<>"']+)/g).forEach((part, i) => {
    if (i % 2 === 0) {
      if (part) frag.appendChild(document.createTextNode(part));
      return;
    }
    const a = el('a', '', part);
    a.href = part;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    frag.appendChild(a);
  });
  return frag;
}

function openLightbox(src) {
  lightbox.querySelector('img').src = src;
  lightbox.classList.remove('hidden');
}

function makeImage(src, onLoad) {
  const img = el('img', 'media');
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.alt = 'obrazek';
  img.addEventListener('load', onLoad);
  img.addEventListener('error', () => img.replaceWith(el('div', 'msg__text', '[nie udało się załadować obrazka]')));
  img.addEventListener('click', () => {
    // Na kanale nsfw obrazki są rozmyte – pierwsze kliknięcie je odsłania.
    if (messagesEl.dataset.nsfw === '1' && !img.classList.contains('revealed')) {
      img.classList.add('revealed');
      return;
    }
    openLightbox(img.src);
  });
  img.src = src;
  return img;
}

function fileIcon(mime, name) {
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime.startsWith('video/')) return '🎬';
  if (mime === 'application/pdf') return '📕';
  if (/\.(zip|rar|7z|tar|gz)$/i.test(name)) return '🗜️';
  if (mime.startsWith('text/')) return '📄';
  return '📎';
}

const INLINE_IMAGE = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/;
const INLINE_VIDEO = /^video\/(mp4|webm|ogg|quicktime)$/;
const INLINE_AUDIO = /^audio\/(mpeg|mp3|ogg|wav|webm|mp4|aac|x-m4a|flac)$/;

// ---------- Archiwum lokalne (IndexedDB) ----------
// Wiadomości (i opcjonalnie pliki) zapisane na tym urządzeniu nie znikają, gdy serwer usunie je po 7 dniach.
const reqP = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const txDone = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

const archive = {
  db: null,
  ready: false,

  open() {
    return new Promise((resolve) => {
      if (!window.indexedDB) return resolve(false);
      try {
        const req = indexedDB.open('mychat-archive', 2);
        req.onupgradeneeded = (ev) => {
          const db = req.result;
          let messages;
          if (ev.oldVersion < 1) {
            messages = db.createObjectStore('messages', { keyPath: 'id' });
            messages.createIndex('time', 'time');
            db.createObjectStore('files');
          } else {
            messages = req.transaction.objectStore('messages');
          }
          if (ev.oldVersion < 2) {
            // wersja 2: kanały – indeks po (kanał, czas); starsze wiadomości trafiają do #ogólny
            messages.createIndex('channel_time', ['channel', 'time']);
            messages.openCursor().onsuccess = (e) => {
              const cur = e.target.result;
              if (!cur) return;
              if (!cur.value.channel) cur.update({ ...cur.value, channel: 'ogolny' });
              cur.continue();
            };
          }
        };
        req.onsuccess = () => {
          this.db = req.result;
          this.ready = true;
          resolve(true);
        };
        req.onerror = () => resolve(false);
      } catch {
        resolve(false); // np. tryb prywatny – czat działa dalej bez archiwum
      }
    });
  },

  async put(messages) {
    if (!this.ready || !messages.length) return;
    const tx = this.db.transaction('messages', 'readwrite');
    messages.forEach((m) => tx.objectStore('messages').put(m));
    await txDone(tx);
  },

  async putFile(id, blob) {
    const tx = this.db.transaction('files', 'readwrite');
    tx.objectStore('files').put(blob, id);
    await txDone(tx);
  },

  getFile: (id) => reqP(archive.db.transaction('files').objectStore('files').get(id)),
  fileIds: () => reqP(archive.db.transaction('files').objectStore('files').getAllKeys()),
  count: () => reqP(archive.db.transaction('messages').objectStore('messages').count()),
  countChannel: (channel) =>
    reqP(
      archive.db
        .transaction('messages')
        .objectStore('messages')
        .index('channel_time')
        .count(IDBKeyRange.bound([channel, 0], [channel, Number.MAX_SAFE_INTEGER]))
    ),

  async all() {
    const list = await reqP(this.db.transaction('messages').objectStore('messages').getAll());
    return list.sort((a, b) => a.time - b.time);
  },

  // `limit` najnowszych wiadomości z kanału, od najstarszej do najnowszej
  recent(channel, limit) {
    return new Promise((resolve, reject) => {
      const out = [];
      const range = IDBKeyRange.bound([channel, 0], [channel, Number.MAX_SAFE_INTEGER]);
      const cursor = this.db.transaction('messages').objectStore('messages').index('channel_time').openCursor(range, 'prev');
      cursor.onsuccess = () => {
        const cur = cursor.result;
        if (cur && out.length < limit) {
          out.push(cur.value);
          cur.continue();
        } else {
          resolve(out.reverse());
        }
      };
      cursor.onerror = () => reject(cursor.error);
    });
  },

  async remove(id) {
    if (!this.ready) return;
    const tx = this.db.transaction(['messages', 'files'], 'readwrite');
    tx.objectStore('messages').delete(id);
    tx.objectStore('files').delete(id);
    await txDone(tx);
  },

  async removeMany(ids) {
    if (!this.ready || !ids.length) return;
    const tx = this.db.transaction(['messages', 'files'], 'readwrite');
    ids.forEach((id) => {
      tx.objectStore('messages').delete(id);
      tx.objectStore('files').delete(id);
    });
    await txDone(tx);
  },

  async clear() {
    if (!this.ready) return;
    const tx = this.db.transaction(['messages', 'files'], 'readwrite');
    tx.objectStore('messages').clear();
    tx.objectStore('files').clear();
    await txDone(tx);
  },
};
archive.opening = archive.open();

// ---------- Kopia zapasowa profilu (w tej przeglądarce) ----------
// Gdy serwer zgubi konta (restart darmowego Rendera), urządzenie samo odtwarza z niej avatar, baner,
// opis i status. Kopia zawiera też pełne obrazy (także GIF-y), których nie mieści localStorage.
const backup = {
  db: null,
  data: null, // { avatar, banner, bio, pronouns, statusText, status, bannerColor, createdAt, avatarUrl, bannerUrl }

  open() {
    return new Promise((resolve) => {
      if (!window.indexedDB) return resolve();
      try {
        const req = indexedDB.open('mychat-profile', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = async () => {
          this.db = req.result;
          try {
            this.data = (await reqP(this.db.transaction('kv').objectStore('kv').get('backup'))) || null;
          } catch {
            this.data = null;
          }
          resolve();
        };
        req.onerror = () => resolve();
      } catch {
        resolve(); // np. tryb prywatny – czat działa dalej bez kopii
      }
    });
  },

  async save(patch) {
    this.data = { ...(this.data || {}), ...patch };
    if (!this.db) return;
    try {
      const tx = this.db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(this.data, 'backup');
      await txDone(tx);
    } catch (err) {
      handleArchiveError(err);
    }
  },
};
backup.ready = backup.open();

async function urlToDataUrl(url) {
  const res = await fetch(url);
  const blob = await res.blob();
  if (!res.ok || blob.size > 2 * 1024 * 1024) throw new Error('Nie udało się pobrać obrazu.');
  return readAsDataUrl(blob);
}

// Po zwykłym logowaniu: zapisz w kopii aktualny stan profilu z serwera (obrazy tylko gdy się zmieniły).
async function refreshBackup(res) {
  const p = res.profile || {};
  const known = backup.data || {};
  const patch = {
    bio: p.bio,
    pronouns: p.pronouns,
    statusText: p.statusText,
    status: p.status,
    bannerColor: p.bannerColor,
    nickColor: p.nickColor,
    nickFont: p.nickFont,
    createdAt: res.createdAt,
  };
  for (const [field, url] of [['avatar', res.avatar || null], ['banner', p.banner || null]]) {
    const urlKey = `${field}Url`;
    if (url === (known[urlKey] ?? null) && (!url || known[field])) continue; // bez zmian
    try {
      patch[field] = url ? await urlToDataUrl(url) : null;
      patch[urlKey] = url;
    } catch {
      /* brak sieci albo obraz za duży – zostaje poprzednia kopia */
    }
  }
  await backup.save(patch);
}

// Serwer założył konto od nowa (zgubił dane) – odtwórz profil z kopii zapasowej.
function restoreProfile() {
  const b = backup.data;
  if (!b) return;
  const payload = {
    avatar: b.avatar || null,
    createdAt: b.createdAt,
    bio: b.bio || '',
    pronouns: b.pronouns || '',
    statusText: b.statusText || '',
    status: b.status || 'online',
    bannerColor: b.bannerColor ?? null,
    nickColor: b.nickColor ?? null,
    nickFont: b.nickFont ?? null,
  };
  if (b.banner) payload.banner = b.banner;
  socket.timeout(30000).emit('profile:restore', payload, (err, r) => {
    if (err || !r || !r.ok) return;
    myProfile = r.profile;
    myCreatedAt = r.createdAt;
    profile.avatar = r.avatar || null;
    store.set('mychat.profile', profile);
    avatars.set(myNick, profile.avatar);
    refreshAvatars();
    updateMeStatus();
    backup.save({ avatarUrl: r.avatar || null, bannerUrl: r.profile.banner || null, createdAt: r.createdAt });
    toast('Serwer zgubił dane – przywrócono Twój profil z kopii zapasowej.', true);
  });
}

const sessionLog = new Map(); // id -> wiadomość (bez zawartości plików) widziana w tej sesji
const localFileIds = new Set(); // id plików zapisanych lokalnie
let quotaWarned = false;

function slimMessage(m) {
  const { data, senderId, ...rest } = m; // bez bajtów pliku i tymczasowego id połączenia
  return { ...rest, channel: rest.channel || 'ogolny' };
}

function logMessage(m) {
  if (!m.id) return;
  sessionLog.set(m.id, slimMessage(m));
  if (sessionLog.size > 5000) sessionLog.delete(sessionLog.keys().next().value);
}

function handleArchiveError(err) {
  console.warn('Archiwum lokalne:', err);
  if (!quotaWarned && err && err.name === 'QuotaExceededError') {
    quotaWarned = true;
    toast('Brak miejsca w archiwum lokalnym. Wyczyść je w ustawieniach.');
  }
}

async function saveFileLocally(m, data) {
  if (!settings.archive || !settings.archiveFiles || !archive.ready) return;
  try {
    await archive.put([slimMessage(m)]);
    await archive.putFile(m.id, new Blob([data], { type: m.mime }));
    localFileIds.add(m.id);
  } catch (err) {
    handleArchiveError(err);
  }
}

async function archiveSave(m) {
  if (!settings.archive || !archive.ready || !m.id) return;
  try {
    await archive.put([slimMessage(m)]);
    if (m.kind === 'file' && m.data) await saveFileLocally(m, m.data);
  } catch (err) {
    handleArchiveError(err);
  }
}

// Zawartość pliku: najpierw z archiwum lokalnego, a jeśli jej tam nie ma – z serwera.
async function loadFileBytes(m) {
  if (archive.ready && localFileIds.has(m.id)) {
    try {
      const blob = await archive.getFile(m.id);
      if (blob) return { data: await blob.arrayBuffer() };
    } catch {
      /* spróbujemy z serwera */
    }
  }
  return new Promise((resolve) => {
    socket.timeout(60000).emit('getFile', m.id, (err, res) => {
      if (err || !res || !res.ok) return resolve({ error: (res && res.error) || 'Nie udało się pobrać pliku.' });
      saveFileLocally(m, res.data);
      resolve({ data: res.data });
    });
  });
}

// Karta pliku z historii: zawartość jest pobierana dopiero po kliknięciu.
function makeRemoteFileCard(m, onLoad) {
  const card = el('div', 'filecard');
  card.appendChild(el('div', 'filecard__icon', fileIcon(m.mime, m.name)));
  const info = el('div', 'filecard__info');
  info.appendChild(el('div', 'filecard__name', m.name));
  info.appendChild(el('div', 'filecard__size', formatSize(m.size) + (localFileIds.has(m.id) ? ' · 💾 zapisano lokalnie' : '')));
  card.appendChild(info);

  const inline = INLINE_IMAGE.test(m.mime) || INLINE_VIDEO.test(m.mime) || INLINE_AUDIO.test(m.mime);
  const btn = el('button', 'icon-btn', inline ? '👁' : '⬇');
  btn.type = 'button';
  btn.title = inline ? 'Pokaż' : 'Pobierz';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const res = await loadFileBytes(m);
    btn.disabled = false;
    if (res.error) return toast(res.error);
    const content = makeFileContent({ ...m, data: res.data }, onLoad);
    card.replaceWith(content);
    if (!inline) content.querySelector('a[download]')?.click(); // od razu pobierz
    onLoad();
  });
  card.appendChild(btn);
  return card;
}

function makeFileContent(m, onLoad) {
  if (!m.data) return makeRemoteFileCard(m, onLoad);
  const blob = new Blob([m.data], { type: m.mime });
  const url = URL.createObjectURL(blob);

  if (INLINE_IMAGE.test(m.mime)) return makeImage(url, onLoad);

  if (INLINE_VIDEO.test(m.mime)) {
    const v = el('video', 'media');
    v.controls = true;
    v.preload = 'metadata';
    v.src = url;
    v.addEventListener('loadedmetadata', onLoad);
    return v;
  }

  if (INLINE_AUDIO.test(m.mime)) {
    const a = el('audio', 'media');
    a.controls = true;
    a.src = url;
    return a;
  }

  const card = el('div', 'filecard');
  card.appendChild(el('div', 'filecard__icon', fileIcon(m.mime, m.name)));
  const info = el('div', 'filecard__info');
  info.appendChild(el('div', 'filecard__name', m.name));
  info.appendChild(el('div', 'filecard__size', formatSize(m.size)));
  card.appendChild(info);
  const dl = el('a', 'icon-btn', '⬇');
  dl.href = url;
  dl.download = m.name;
  dl.title = 'Pobierz';
  card.appendChild(dl);
  return card;
}

const ONLY_EMOJI = /^(?:\p{Extended_Pictographic}|‍|️|\s){1,8}$/u;

function addSystem(m) {
  const stick = isNearBottom();
  const leave = m.text.includes('opuścił');
  const node = el('div', 'system' + (leave ? ' system--leave' : ''), m.text);
  node.dataset.time = m.time;
  messagesEl.appendChild(node);
  lastNick = null;
  if (stick) scrollToBottom();
}

// Usuwa z ekranu wiadomości starsze niż okres przechowywania (to samo robi serwer w historii).
// Przy włączonym archiwum lokalnym wiadomości zostają na ekranie – o to w nim chodzi.
function sweepExpired() {
  if (settings.archive && archive.ready) return;
  const cutoff = Date.now() - retentionMs;
  messagesEl.querySelectorAll('[data-time]').forEach((node) => {
    if (Number(node.dataset.time) >= cutoff) return;
    node.querySelectorAll('[src^="blob:"], [href^="blob:"]').forEach((n) => {
      URL.revokeObjectURL(n.getAttribute('src') || n.getAttribute('href'));
    });
    node.remove();
  });
}

// Moja wiadomość? Po koncie (przeżywa zmianę nicku); stare wiadomości bez konta – po nicku.
// Urządzenie może mieć za sobą kilka kont (serwer na darmowym Renderze gubi je przy restarcie, a po
// ponownym zalogowaniu powstaje nowe) i kilka nicków (zmiana nicku). Pamiętamy je wszystkie, żeby
// stare wiadomości w archiwum nadal były rozpoznawane jako Twoje – i dało się je usunąć.
const identity = {
  accountIds: new Set(store.get('mychat.ids', { list: [] }).list),
  nicks: new Set(store.get('mychat.nicks', { list: [] }).list),
};

function rememberIdentity(accountId, nick) {
  if (accountId) identity.accountIds.add(accountId);
  if (nick) identity.nicks.add(nick);
  store.set('mychat.ids', { list: Array.from(identity.accountIds).slice(-50) });
  store.set('mychat.nicks', { list: Array.from(identity.nicks).slice(-50) });
}

function isMine(m) {
  return m.accountId ? identity.accountIds.has(m.accountId) : identity.nicks.has(m.nick);
}

// Wiadomości z archiwum napisane Twoim nickiem przez wcześniejsze konta (sprzed resetów serwera) też są Twoje.
let identityBackfill = null;
async function backfillIdentity() {
  try {
    await archive.opening;
    if (!archive.ready) return;
    let changed = false;
    for (const m of await archive.all()) {
      if (m.accountId && !identity.accountIds.has(m.accountId) && identity.nicks.has(m.nick)) {
        identity.accountIds.add(m.accountId);
        changed = true;
      }
    }
    if (changed) rememberIdentity();
  } catch (err) {
    handleArchiveError(err);
  }
}

function dayLabel(ts) {
  return new Date(ts).toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// Avatar i nick przy wiadomości otwierają miniprofil autora (obsługuje to jedno wspólne kliknięcie niżej).
function markProfileTrigger(node, nick, accountId) {
  node.classList.add('js-profile');
  node.dataset.nick = nick;
  node.dataset.account = accountId || '';
}

function makeMessageHeader(nick, time, accountId) {
  const head = el('div', 'msg__head');
  const author = el('span', 'msg__author', nick);
  markProfileTrigger(author, nick, accountId);
  applyNickStyle(author, nick, accountId);
  head.appendChild(author);
  head.appendChild(el('span', 'msg__time', formatTime(time)));
  return head;
}

function makeMessageAvatar(nick, accountId) {
  const avatar = makeAvatar(nick, 'msg__avatar');
  markProfileTrigger(avatar, nick, accountId);
  return avatar;
}

// Gdy usunięto pierwszą wiadomość z grupy, następna musi dostać nagłówek (avatar i nick).
function promoteToFirst(node) {
  node.classList.add('msg--first');
  node.querySelector('.msg__hovertime')?.remove();
  node.prepend(makeMessageHeader(node.dataset.nick, Number(node.dataset.time), node.dataset.account));
  node.prepend(makeMessageAvatar(node.dataset.nick, node.dataset.account));
}

function removeMessageNode(id) {
  const node = messagesEl.querySelector(`.msg[data-id="${CSS.escape(id)}"]`);
  if (!node) return;
  node.querySelectorAll('[src^="blob:"], [href^="blob:"]').forEach((n) => {
    URL.revokeObjectURL(n.getAttribute('src') || n.getAttribute('href'));
  });
  const prev = node.previousElementSibling;
  const next = node.nextElementSibling;
  const wasFirst = node.classList.contains('msg--first');
  node.remove();

  if (wasFirst && next && next.classList.contains('msg') && !next.classList.contains('msg--first') && next.dataset.nick === node.dataset.nick) {
    promoteToFirst(next);
  }
  // Pusty separator dnia (nic już po nim nie ma) usuwamy.
  if (prev && prev.classList.contains('daysep') && (!next || next.classList.contains('daysep'))) prev.remove();
}

function requestDelete(id) {
  if (!confirm('Usunąć tę wiadomość? Zniknie u wszystkich, którzy mają ją na serwerze, oraz z Twojego archiwum.')) return;
  socket.timeout(10000).emit('deleteMessage', id, (err, res) => {
    if (!err && res && res.ok) return; // serwer rozesłał usunięcie – ekran i archiwum posprzątają się same
    if (res && res.code === 'gone') {
      // Serwer już nie ma tej wiadomości (wygasła albo serwer zgubił dane), ale jest jeszcze w Twoim archiwum.
      applyDeletions([id]);
      return toast('Usunięto wiadomość z tego urządzenia (serwer już jej nie przechowywał).', true);
    }
    toast((res && res.error) || 'Nie udało się usunąć wiadomości.');
  });
}

function addMessage(m, { historic = false } = {}) {
  const mine = isMine(m);
  const stick = historic || mine || isNearBottom();

  // Separator z datą przy zmianie dnia (i na początku listy)
  const day = new Date(m.time).toDateString();
  const newDay = day !== lastDay;
  if (newDay) {
    const sep = el('div', 'daysep');
    sep.appendChild(el('span', '', dayLabel(m.time)));
    sep.dataset.time = m.time;
    messagesEl.appendChild(sep);
    lastDay = day;
  }

  const first = newDay || m.nick !== lastNick || m.time - lastMessageTime > GROUP_WINDOW_MS;
  const wrap = el('div', 'msg' + (first ? ' msg--first' : '') + (historic ? ' msg--static' : ''));
  wrap.dataset.time = m.time;
  wrap.dataset.nick = m.nick;
  wrap.dataset.account = m.accountId || '';
  if (m.id) wrap.dataset.id = m.id;

  if (first) {
    wrap.appendChild(makeMessageAvatar(m.nick, m.accountId));
    wrap.appendChild(makeMessageHeader(m.nick, m.time, m.accountId));
  } else {
    wrap.appendChild(el('span', 'msg__hovertime', formatTime(m.time)));
  }

  if (mine && m.id) {
    const actions = el('div', 'msg__actions');
    const del = el('button', 'msg__action msg__action--danger', '🗑');
    del.type = 'button';
    del.title = 'Usuń wiadomość';
    del.setAttribute('aria-label', 'Usuń wiadomość');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      requestDelete(m.id);
    });
    actions.appendChild(del);
    wrap.appendChild(actions);
  }

  const afterMediaLoad = () => {
    if (stick) scrollToBottom();
  };

  if (m.kind === 'gif') {
    wrap.appendChild(makeImage(m.url, afterMediaLoad));
  } else if (m.kind === 'file') {
    wrap.appendChild(makeFileContent(m, afterMediaLoad));
  } else {
    const body = el('div', 'msg__text' + (ONLY_EMOJI.test(m.text) ? ' msg__text--emoji' : ''));
    body.appendChild(linkify(m.text));
    wrap.appendChild(body);
  }

  messagesEl.appendChild(wrap);
  lastNick = m.nick;
  lastMessageTime = m.time;
  if (stick) scrollToBottom();

  if (!mine && !historic) {
    beep();
    if (document.hidden) {
      unread += 1;
      document.title = `(${unread}) MyChat`;
    }
  }
}

function renderTyping() {
  const names = Array.from(typingUsers);
  if (names.length === 0) return typingEl.replaceChildren();
  const dots = el('span', 'dots');
  dots.append(el('i'), el('i'), el('i'));
  const label = names.length === 1 ? `${names[0]} pisze…` : `${names.join(', ')} piszą…`;
  typingEl.replaceChildren(dots, document.createTextNode(label));
}

function renderMembers(list) {
  list.forEach((u) => {
    avatars.set(u.nick, u.avatar);
    setNickStyle(u.id, u.nick, u);
  });
  onlineEl.textContent = `${list.length} online`;
  membersTitleEl.textContent = `ONLINE — ${list.length}`;
  membersListEl.replaceChildren(
    ...list.map((u) => {
      const row = el('div', 'member');
      markProfileTrigger(row, u.nick, u.id);
      const avatar = makeAvatar(u.nick, 'avatar--sm avatar--dot');
      avatar.dataset.status = u.status || 'online';
      row.appendChild(avatar);

      const text = el('div', 'member__text');
      const name = el('span', 'member__name', u.nick);
      applyNickStyle(name, u.nick, u.id);
      text.appendChild(name);
      if (u.statusText) text.appendChild(el('span', 'member__status', u.statusText));
      row.appendChild(text);
      return row;
    })
  );
  refreshAvatars();
  refreshNickStyles(); // ktoś mógł zmienić styl nicku – odśwież też wiadomości na ekranie
}

// ---------- Miniprofil ----------
const STATUS_LABELS = { online: 'Online', idle: 'Zaraz wracam', dnd: 'Nie przeszkadzać', offline: 'Offline' };
const popout = $('profile-popout');

let myProfile = { bio: '', pronouns: '', statusText: '', status: 'online', bannerColor: null, banner: null };
let myCreatedAt = null;

// Rysuje kartę profilu (używaną w miniprofilu i w podglądzie w ustawieniach).
function renderProfileCard(root, p, { isMe = false, onEdit = null } = {}) {
  const presence = p.online === false ? 'offline' : p.status || 'online';

  const banner = el('div', 'pcard__banner');
  if (isSafeImageSrc(p.banner)) banner.style.backgroundImage = `url("${p.banner}")`;
  else banner.style.background = p.bannerColor || colorFor(p.nick);

  const body = el('div', 'pcard__body');
  const avatar = el('div', 'avatar avatar--dot pcard__avatar');
  avatar.dataset.status = presence;
  setAvatarVisual(avatar, p.nick, p.avatar);
  body.appendChild(avatar);

  const nameEl = el('div', 'pcard__name', p.nick);
  styleNick(nameEl, p.nick, { color: p.nickColor, font: p.nickFont }, '');
  body.appendChild(nameEl);
  if (p.pronouns) body.appendChild(el('div', 'pcard__pronouns', p.pronouns));
  body.appendChild(
    el('div', 'pcard__status' + (p.statusText ? '' : ' pcard__muted'), p.statusText || STATUS_LABELS[presence])
  );

  const box = el('div', 'pcard__box');
  box.appendChild(el('div', 'pcard__label', 'O MNIE'));
  box.appendChild(el('div', 'pcard__text' + (p.bio ? '' : ' pcard__muted'), p.bio || 'Brak opisu.'));
  box.appendChild(el('div', 'pcard__label', 'CZŁONEK OD'));
  const since = p.createdAt
    ? new Date(p.createdAt).toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', year: 'numeric' })
    : '—';
  box.appendChild(el('div', 'pcard__text', since));
  body.appendChild(box);

  if (isMe && onEdit) {
    const edit = el('button', 'btn-secondary btn-sm pcard__edit', 'Edytuj profil');
    edit.type = 'button';
    edit.addEventListener('click', onEdit);
    body.appendChild(edit);
  }
  root.replaceChildren(banner, body);
}

let popoutTrigger = null;

function closeProfilePopout() {
  popout.classList.add('hidden');
  popoutTrigger = null;
}

function positionPopout(anchor) {
  if (!anchor || window.innerWidth <= 720) return; // na telefonie karta jest wyśrodkowana przez CSS
  const rect = anchor.getBoundingClientRect();
  const w = popout.offsetWidth;
  const h = popout.offsetHeight;
  let left = rect.right + 10;
  if (left + w > window.innerWidth - 8) left = rect.left - w - 10; // nie mieści się z prawej – na lewo od elementu
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  const top = Math.max(8, Math.min(rect.top, window.innerHeight - h - 8));
  popout.style.left = `${left}px`;
  popout.style.top = `${top}px`;
}

function openProfile(query, anchor) {
  if (popoutTrigger === anchor && !popout.classList.contains('hidden')) return closeProfilePopout(); // drugie kliknięcie zamyka
  socket.timeout(8000).emit('profile:get', query, (err, res) => {
    if (err || !res || !res.ok) return toast((res && res.error) || 'Nie udało się wczytać profilu.');
    const p = res.profile;
    if (setNickStyle(p.id, p.nick, p)) refreshNickStyles();
    renderProfileCard(popout, p, {
      isMe: p.id === myAccountId,
      onEdit: () => {
        closeProfilePopout();
        openSettings();
        $('profile-section').scrollIntoView({ block: 'start' });
      },
    });
    popout.classList.remove('hidden');
    positionPopout(anchor);
    popoutTrigger = anchor;
  });
}

document.addEventListener('click', (e) => {
  const trigger = e.target.closest('.js-profile');
  if (trigger) {
    openProfile({ id: trigger.dataset.account || undefined, nick: trigger.dataset.nick }, trigger);
  } else if (!e.target.closest('#profile-popout')) {
    closeProfilePopout();
  }
});

// Edycja własnego profilu w ustawieniach (zmiany widać na żywo w podglądzie, zapisujemy przyciskiem)
let draft = { ...myProfile };

function updateProfilePreview() {
  if (!myNick) return;
  renderProfileCard($('profile-preview'), {
    id: myAccountId,
    nick: myNick,
    avatar: profile.avatar,
    createdAt: myCreatedAt,
    online: true,
    ...draft,
    banner: draft.bannerPreview || draft.banner,
  });
}

let bannerChanged = false; // baner wysyłamy na serwer tylko wtedy, gdy go zmieniono (to może być ciężki GIF)

function setBannerPreview(url) {
  if (draft.bannerPreview) URL.revokeObjectURL(draft.bannerPreview);
  draft.bannerPreview = url;
}

function loadProfileForm() {
  setBannerPreview(null);
  draft = { ...myProfile };
  bannerChanged = false;
  $('profile-status').value = draft.status;
  $('profile-status-text').value = draft.statusText;
  $('profile-pronouns').value = draft.pronouns;
  $('profile-bio').value = draft.bio;
  $('profile-banner-color').value = draft.bannerColor || colorFor(myNick || 'x');
  $('bio-counter').textContent = `${draft.bio.length}/190`;
  renderNickStyleEditor();
  updateProfilePreview();
}

// Wybór koloru i czcionki nicku: próbki pokazują Twój nick w danym kroju i kolorze.
function renderNickStyleEditor() {
  const nick = myNick || 'Nick';
  $('nick-color').value = draft.nickColor || colorFor(nick);

  $('nick-swatches').replaceChildren(
    ...NICK_COLORS.map((c) => {
      const s = el('button', 'swatch' + (c === draft.nickColor ? ' is-selected' : ''));
      s.type = 'button';
      s.style.background = c;
      s.setAttribute('aria-label', `Kolor nicku ${c}`);
      s.addEventListener('click', () => setDraftNickStyle({ nickColor: c }));
      return s;
    })
  );

  $('font-grid').replaceChildren(
    ...NICK_FONTS.map((f) => {
      const selected = (draft.nickFont || 'default') === f.id;
      const btn = el('button', 'font-btn' + (selected ? ' is-selected' : ''));
      btn.type = 'button';
      const sample = el('span', 'font-btn__sample', nick);
      styleNick(sample, nick, { color: draft.nickColor, font: f.id }, colorFor(nick));
      btn.append(sample, el('span', 'font-btn__name', f.name));
      btn.addEventListener('click', () => setDraftNickStyle({ nickFont: f.id === 'default' ? null : f.id }));
      return btn;
    })
  );
}

function setDraftNickStyle(patch) {
  Object.assign(draft, patch);
  renderNickStyleEditor();
  updateProfilePreview();
}

$('nick-color').addEventListener('input', (e) => {
  draft.nickColor = e.target.value;
  updateProfilePreview();
  // bez przebudowy całej siatki podczas przeciągania suwaka koloru – odświeżamy tylko próbki
  document.querySelectorAll('.font-btn__sample').forEach((n, i) => {
    styleNick(n, myNick, { color: draft.nickColor, font: NICK_FONTS[i].id }, colorFor(myNick));
  });
  document.querySelectorAll('#nick-swatches .swatch').forEach((s) => s.classList.remove('is-selected'));
});
$('nick-color-reset').addEventListener('click', () => setDraftNickStyle({ nickColor: null }));

function updateMeStatus() {
  meAvatarEl.classList.add('avatar--dot');
  meAvatarEl.dataset.status = myProfile.status || 'online';
  document.querySelector('.userpanel__status').textContent = myProfile.statusText || STATUS_LABELS[myProfile.status || 'online'];
}

$('profile-status').addEventListener('change', (e) => {
  draft.status = e.target.value;
  updateProfilePreview();
});
$('profile-status-text').addEventListener('input', (e) => {
  draft.statusText = e.target.value;
  updateProfilePreview();
});
$('profile-pronouns').addEventListener('input', (e) => {
  draft.pronouns = e.target.value;
  updateProfilePreview();
});
$('profile-bio').addEventListener('input', (e) => {
  draft.bio = e.target.value;
  $('bio-counter').textContent = `${draft.bio.length}/190`;
  updateProfilePreview();
});
$('profile-banner-color').addEventListener('input', (e) => {
  draft.bannerColor = e.target.value;
  draft.banner = null; // wybór koloru zastępuje obraz
  setBannerPreview(null);
  bannerChanged = true;
  updateProfilePreview();
});
$('banner-remove').addEventListener('click', () => {
  draft.bannerColor = null;
  draft.banner = null;
  setBannerPreview(null);
  bannerChanged = true;
  $('profile-banner-color').value = colorFor(myNick || 'x');
  updateProfilePreview();
});
$('banner-upload').addEventListener('click', () => $('banner-file').click());
$('banner-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    draft.banner = await fileToBanner(file);
    setBannerPreview(URL.createObjectURL(file)); // lekki podgląd (bez wstawiania całego pliku do strony)
    bannerChanged = true;
    updateProfilePreview();
  } catch (err) {
    toast(err.message);
  }
});

// Baner: zwykłe obrazy są kadrowane do 600x200 (jakość spada, aż zmieszczą się w limicie serwera);
// animowany GIF zostaje w oryginale, żeby nie stracić animacji.
function fileToBanner(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('To nie jest obrazek.'));
    if (file.type === 'image/gif') {
      if (file.size > gifBannerBytes) {
        return reject(new Error(`Animowany baner (GIF) może mieć maksymalnie ${formatSize(gifBannerBytes)}.`));
      }
      return readAsDataUrl(file).then(resolve, reject);
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const W = 600;
      const H = 200;
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const scale = Math.max(W / img.width, H / img.height);
      const sw = W / scale;
      const sh = H / scale;
      canvas.getContext('2d').drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, W, H);
      for (const quality of [0.8, 0.65, 0.5, 0.35]) {
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        if (dataUrl.length <= 55000) return resolve(dataUrl);
      }
      reject(new Error('Ten obraz jest zbyt szczegółowy – wybierz prostszy.'));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Nie udało się wczytać obrazka.'));
    };
    img.src = url;
  });
}

$('profile-save').addEventListener('click', () => {
  const btn = $('profile-save');
  btn.disabled = true;
  const { banner, bannerPreview, ...fields } = draft;
  const changedBanner = bannerChanged;
  const payload = changedBanner ? { ...fields, banner } : fields;
  socket.timeout(30000).emit('profile:update', payload, (err, res) => {
    btn.disabled = false;
    if (err || !res || !res.ok) return toast((res && res.error) || 'Nie udało się zapisać profilu.');
    myProfile = res.profile;
    const { bio, pronouns, statusText, status, bannerColor, nickColor, nickFont } = res.profile;
    setNickStyle(myAccountId, myNick, res.profile);
    refreshNickStyles(); // nick ma od razu nowy wygląd w całym czacie
    backup.save({
      bio,
      pronouns,
      statusText,
      status,
      bannerColor,
      nickColor,
      nickFont,
      ...(changedBanner ? { banner, bannerUrl: res.profile.banner || null } : {}),
    });
    bannerChanged = false;
    setBannerPreview(null);
    draft.banner = myProfile.banner; // od teraz adres z serwera
    updateProfilePreview();
    updateMeStatus();
    toast('Profil zapisany.', true);
  });
});

// ---------- Dźwięk ----------
let audioCtx;
function getAudioCtx() {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function beep(freqs = [660, 880]) {
  if (!settings.sound) return;
  try {
    getAudioCtx();
    const t = audioCtx.currentTime;
    freqs.forEach((freq, i) => {
      const start = t + i * 0.09;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.1, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(start);
      osc.stop(start + 0.13);
    });
  } catch {
    /* brak audio – pomijamy */
  }
}

// ---------- Logowanie ----------
// Konto jest przypisane do urządzenia: losowy, tajny token w localStorage (serwer zna tylko jego skrót).
let memoryToken = null; // zapas, gdy przeglądarka blokuje localStorage (konto trwa wtedy do zamknięcia karty)

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function getDeviceToken() {
  try {
    let token = localStorage.getItem('mychat.device');
    if (!token || token.length < 32) {
      token = randomToken();
      localStorage.setItem('mychat.device', token);
    }
    return token;
  } catch {
    memoryToken = memoryToken || randomToken();
    return memoryToken;
  }
}

const loginFields = $('login-fields');
const loginAuto = $('login-auto');

function showLoginFields() {
  loginAuto.classList.add('hidden');
  loginFields.classList.remove('hidden');
  loginScreen.classList.remove('hidden');
  chatScreen.classList.add('hidden');
}

function showAutoLogin(nick) {
  $('login-auto-name').textContent = nick;
  loginFields.classList.add('hidden');
  loginAuto.classList.remove('hidden');
}

function join(nick) {
  const payload = {
    token: getDeviceToken(),
    nick,
    avatar: pendingAvatar || profile.avatarData || null, // liczy się tylko przy zakładaniu nowego konta
    channel: currentChannel,
    adult: adultConfirmed,
  };
  socket.emit('join', payload, (res) => {
    if (!res || !res.ok) {
      myNick = null;
      loginError.textContent = (res && res.error) || 'Nie udało się dołączyć.';
      nickInput.value = profile.nick || '';
      showLoginFields();
      return;
    }
    myNick = res.nick;
    myAccountId = res.accountId || null;
    rememberIdentity(myAccountId, res.nick);
    identityBackfill = backfillIdentity();
    myCreatedAt = res.createdAt || null;
    if (res.profile) {
      myProfile = res.profile;
      setNickStyle(myAccountId, myNick, res.profile);
    }
    if (Array.isArray(res.channels) && res.channels.length) channels = res.channels;
    currentChannel = res.channel || DEFAULT_CHANNEL; // serwer mógł zmienić kanał (np. brak zgody na nsfw)
    historyLoading = true; // zaraz po zalogowaniu serwer wyśle historię kanału
    pendingLive.length = 0;
    unreadChannels.delete(currentChannel);
    renderChannels();
    syncDeletions();
    profile = {
      nick: res.nick,
      avatar: res.avatar || null,
      avatarData: smallData(pendingAvatar) || profile.avatarData || null,
    };
    pendingAvatar = profile.avatarData;
    store.set('mychat.profile', profile);
    avatars.set(myNick, profile.avatar);
    loginError.textContent = '';
    loginScreen.classList.add('hidden');
    chatScreen.classList.remove('hidden');

    meNameEl.textContent = myNick;
    applyNickStyle(meNameEl, myNick, myAccountId);
    meAvatarEl.dataset.nick = myNick;
    $('settings-avatar').dataset.nick = myNick;
    refreshAvatars();
    updateMeStatus();
    messageInput.focus();

    // Kopia zapasowa profilu: po zwykłym logowaniu odświeżamy ją, a gdy serwer założył konto od nowa
    // (zgubił dane), odtwarzamy z niej profil.
    backup.ready.then(() => (res.isNew ? restoreProfile() : refreshBackup(res)));

    // Po utracie połączenia wracamy na kanał głosowy (każda osoba robi to sama, więc rozmowa się odtwarza).
    if (voiceRejoin) {
      voiceRejoin = false;
      joinVoice();
    }
  });
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const nick = nickInput.value.trim();
  if (!nick) return;
  profile = { ...profile, nick, avatarData: smallData(pendingAvatar) };
  join(nick);
});

// Zmiana nicku (konto zostaje to samo, zmienia się tylko nazwa)
function renameMe() {
  const input = $('rename-input');
  const nick = input.value.trim();
  if (!nick || nick === myNick) return;
  socket.timeout(10000).emit('rename', nick, (err, res) => {
    if (err || !res || !res.ok) return toast((res && res.error) || 'Nie udało się zmienić nicku.');
    myNick = res.nick;
    rememberIdentity(myAccountId, myNick);
    profile.nick = res.nick;
    store.set('mychat.profile', profile);
    avatars.set(myNick, profile.avatar);
    meNameEl.textContent = myNick;
    setNickStyle(myAccountId, myNick, myProfile);
    applyNickStyle(meNameEl, myNick, myAccountId);
    meAvatarEl.dataset.nick = myNick;
    $('settings-avatar').dataset.nick = myNick;
    refreshAvatars();
    updateProfilePreview();
    toast(`Twój nick to teraz ${myNick}`, true);
  });
}
$('rename-btn').addEventListener('click', renameMe);
$('rename-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    renameMe();
  }
});

// ---------- Wysyłanie wiadomości ----------
messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !socket.connected) return;
  socket.emit('message', text);
  socket.emit('typing', false);
  clearTimeout(typingTimeout);
  messageInput.value = '';
  messageInput.focus();
  closePopups();
});

messageInput.addEventListener('input', () => {
  socket.emit('typing', true);
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => socket.emit('typing', false), 1500);
});

// ---------- Pliki ----------
function showUpload(name) {
  const wrap = el('div', 'msg msg--first');
  wrap.appendChild(makeAvatar(myNick, 'msg__avatar'));
  const head = el('div', 'msg__head');
  const author = el('span', 'msg__author', myNick);
  applyNickStyle(author, myNick, myAccountId);
  head.appendChild(author);
  wrap.appendChild(head);
  const box = el('div', 'upload');
  box.appendChild(el('div', '', `Wysyłanie: ${name}`));
  box.appendChild(el('div', 'upload__bar'));
  wrap.appendChild(box);
  messagesEl.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

async function sendFile(file) {
  if (!file) return;
  if (!socket.connected) return toast('Brak połączenia z serwerem.');
  if (file.size === 0) return toast('Ten plik jest pusty.');
  if (file.size > maxFileBytes) {
    return toast(`Plik jest za duży – limit to ${Math.round(maxFileBytes / 1024 / 1024)} MB.`);
  }

  const placeholder = showUpload(file.name);
  try {
    const data = await file.arrayBuffer();
    socket.timeout(60000).emit(
      'file',
      { name: file.name, mime: file.type || 'application/octet-stream', data },
      (err, res) => {
        placeholder.remove();
        if (err) toast('Wysyłanie pliku nie powiodło się (przekroczono czas).');
        else if (!res || !res.ok) toast((res && res.error) || 'Nie udało się wysłać pliku.');
      }
    );
  } catch {
    placeholder.remove();
    toast('Nie udało się odczytać pliku.');
  }
}

$('attach-btn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  Array.from(fileInput.files).forEach(sendFile);
  fileInput.value = '';
});

messageInput.addEventListener('paste', (e) => {
  const files = Array.from(e.clipboardData?.files || []);
  if (files.length) {
    e.preventDefault();
    files.forEach(sendFile);
  }
});

// Przeciągnij i upuść
let dragDepth = 0;
const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || !myNick) return;
  dragDepth += 1;
  dropOverlay.classList.remove('hidden');
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.classList.add('hidden');
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.add('hidden');
  if (myNick) Array.from(e.dataTransfer.files).forEach(sendFile);
});

// ---------- Emoji ----------
const EMOJIS =
  '😀😁😂🤣😊😍😘😎🤔😅😭😡🥳😴🤯🥺👍👎👏🙏💪🙌👋🤝❤️🧡💛💚💙💜🖤💔🔥✨🎉🎂🍕🍔🍟🍺☕⚽🎮🎵🚀🌈☀️🌙⭐💯✅❌👀🤖👻💩🐶🐱🦊🐼🐸'.match(
    /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu
  );

EMOJIS.forEach((emoji) => {
  const b = el('button', '', emoji);
  b.type = 'button';
  b.addEventListener('click', () => {
    const start = messageInput.selectionStart ?? messageInput.value.length;
    const end = messageInput.selectionEnd ?? start;
    messageInput.setRangeText(emoji, start, end, 'end');
    messageInput.focus();
  });
  emojiPanel.appendChild(b);
});

function closePopups() {
  emojiPanel.classList.add('hidden');
  gifPanel.classList.add('hidden');
  $('emoji-btn').classList.remove('is-active');
  $('gif-btn').classList.remove('is-active');
}

function togglePopup(panel, btn) {
  const wasHidden = panel.classList.contains('hidden');
  closePopups();
  if (wasHidden) {
    panel.classList.remove('hidden');
    btn.classList.add('is-active');
  }
  return wasHidden;
}

$('emoji-btn').addEventListener('click', () => togglePopup(emojiPanel, $('emoji-btn')));

document.addEventListener('click', (e) => {
  if (!e.target.closest('.popup, #emoji-btn, #gif-btn')) closePopups();
});

// ---------- GIFy ----------
let gifRequest = 0;
let gifTimer = null;

async function loadGifs(query) {
  const request = ++gifRequest;
  gifHint.textContent = 'Ładowanie…';
  try {
    const res = await fetch(`/api/gifs?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error('request failed');
    const list = await res.json();
    if (request !== gifRequest) return;
    gifGrid.replaceChildren(
      ...list.map((g) => {
        const img = el('img');
        img.src = g.preview;
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        img.alt = 'GIF';
        img.addEventListener('click', () => sendGif(g.url));
        return img;
      })
    );
    gifHint.textContent = list.length ? 'Obsługiwane przez GIPHY' : 'Brak wyników.';
  } catch {
    if (request !== gifRequest) return;
    gifGrid.replaceChildren();
    gifHint.textContent = 'Nie udało się pobrać GIFów. Możesz wkleić link poniżej.';
  }
}

function sendGif(url) {
  if (!socket.connected) return toast('Brak połączenia z serwerem.');
  const sendBtn = $('gif-url-send');
  sendBtn.disabled = true; // serwer może chwilę szukać obrazka na stronie Tenor/Giphy
  socket.timeout(15000).emit('gif', url, (err, res) => {
    sendBtn.disabled = false;
    if (err || !res || !res.ok) return toast((res && res.error) || 'Nie udało się wysłać GIFa.');
    gifUrlInput.value = '';
    closePopups();
  });
}

$('gif-btn').addEventListener('click', () => {
  if (!togglePopup(gifPanel, $('gif-btn'))) return;
  if (gifSearchEnabled) {
    gifSearch.classList.remove('hidden');
    loadGifs(gifSearch.value.trim());
    gifSearch.focus();
  } else {
    gifSearch.classList.add('hidden');
    gifGrid.replaceChildren();
    gifHint.textContent =
      'Wyszukiwarka GIFów jest wyłączona (brak klucza GIPHY_API_KEY na serwerze). Wklej link do GIFa z Tenor lub Giphy albo bezpośredni link do obrazka.';
    gifUrlInput.focus();
  }
});

gifSearch.addEventListener('input', () => {
  clearTimeout(gifTimer);
  gifTimer = setTimeout(() => loadGifs(gifSearch.value.trim()), 400);
});

$('gif-url-send').addEventListener('click', () => {
  const url = gifUrlInput.value.trim();
  if (url) sendGif(url);
});
gifUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('gif-url-send').click();
  }
});

// ---------- Ustawienia, lightbox, klawisze ----------
function openSettings() {
  closeProfilePopout();
  loadProfileForm();
  renderSettingsOptions();
  updateArchiveStats();
  $('rename-input').value = myNick || '';
  settingsModal.classList.remove('hidden');
}
function closeSettings() {
  settingsModal.classList.add('hidden');
}

$('settings-btn').addEventListener('click', openSettings);
$('userpanel').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', closeSettings);
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) closeSettings();
});
$('sound-toggle').addEventListener('change', (e) => {
  settings.sound = e.target.checked;
  store.set('mychat.settings', settings);
  if (settings.sound) beep();
});
// ----- Archiwum lokalne: ustawienia, eksport, czyszczenie -----
async function updateArchiveStats() {
  const stats = $('archive-stats');
  if (!archive.ready) {
    stats.textContent = 'Archiwum lokalne jest niedostępne w tej przeglądarce (np. tryb prywatny).';
    return;
  }
  try {
    const [messages, files, estimate] = await Promise.all([
      archive.count(),
      archive.fileIds(),
      navigator.storage?.estimate ? navigator.storage.estimate() : null,
    ]);
    const used = estimate && estimate.usage ? ` · zajęte miejsce ok. ${formatSize(estimate.usage)}` : '';
    stats.textContent = `Zapisano: ${messages} wiadomości, ${files.length} plików${used}.`;
  } catch {
    stats.textContent = '';
  }
}

$('archive-toggle').addEventListener('change', async (e) => {
  settings.archive = e.target.checked;
  store.set('mychat.settings', settings);
  $('archive-files-toggle').disabled = !settings.archive;
  if (settings.archive && archive.ready) {
    // Od razu zapisz wszystko, co mamy na ekranie, żeby nic nie przepadło.
    try {
      await archive.put(Array.from(sessionLog.values()));
    } catch (err) {
      handleArchiveError(err);
    }
    toast('Archiwum lokalne włączone.', true);
  }
  updateArchiveStats();
});

$('archive-files-toggle').addEventListener('change', (e) => {
  settings.archiveFiles = e.target.checked;
  store.set('mychat.settings', settings);
});

$('archive-clear').addEventListener('click', async () => {
  if (!confirm('Usunąć wszystkie wiadomości i pliki zapisane na tym urządzeniu? Kopii na serwerze to nie dotyczy.')) return;
  try {
    await archive.clear();
    localFileIds.clear();
    toast('Archiwum lokalne wyczyszczone.', true);
  } catch (err) {
    handleArchiveError(err);
  }
  updateArchiveStats();
});

function describeMessage(m) {
  if (m.kind === 'gif') return `[GIF] ${m.url}`;
  if (m.kind === 'file') return `[plik] ${m.name} (${formatSize(m.size)})`;
  return m.text;
}

function downloadText(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = el('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function exportChat(format) {
  const map = new Map();
  if (archive.ready) {
    try {
      (await archive.all()).forEach((m) => map.set(m.id, m));
    } catch (err) {
      handleArchiveError(err);
    }
  }
  sessionLog.forEach((m, id) => map.set(id, m));
  const list = Array.from(map.values()).sort((a, b) => a.time - b.time);
  if (!list.length) return toast('Brak wiadomości do zapisania.');

  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'json') {
    downloadText(`mychat-${stamp}.json`, JSON.stringify(list, null, 2), 'application/json');
  } else {
    const lines = list.map((m) => {
      const d = new Date(m.time);
      const when = `${d.toLocaleDateString('pl-PL')} ${d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}`;
      return `[${when}] #${m.channel || DEFAULT_CHANNEL} ${m.nick}: ${describeMessage(m)}`;
    });
    downloadText(`mychat-${stamp}.txt`, `MyChat\n${'='.repeat(30)}\n${lines.join('\n')}\n`, 'text/plain');
  }
  toast(`Zapisano ${list.length} wiadomości do pliku.`, true);
}
$('export-txt').addEventListener('click', () => exportChat('txt'));
$('export-json').addEventListener('click', () => exportChat('json'));

// Na ekranach dotykowych nie ma najechania myszą – dotknięcie wiadomości pokazuje jej akcje.
messagesEl.addEventListener('click', (e) => {
  if (!window.matchMedia('(hover: none)').matches) return;
  const msg = e.target.closest('.msg');
  messagesEl.querySelectorAll('.msg.show-actions').forEach((n) => n !== msg && n.classList.remove('show-actions'));
  if (msg) msg.classList.toggle('show-actions');
});

lightbox.addEventListener('click', () => lightbox.classList.add('hidden'));

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  $('age-gate').classList.add('hidden');
  closeProfilePopout();
  closeSettings();
  closePopups();
  lightbox.classList.add('hidden');
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    unread = 0;
    document.title = 'MyChat';
  }
});

// ---------- Czat głosowy (WebRTC, połączenia peer-to-peer) ----------
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
let maxVoiceUsers = 8;

const voice = {
  active: false,
  joining: false,
  stream: null,
  screen: null, // strumień z naszym udostępnianym ekranem (gdy go udostępniamy)
  muted: false,
  deafened: false,
  users: [], // [{ id, nick, muted, deafened, sharing }] – z serwera
  peers: new Map(), // socket.id -> { pc, pending, audio }
};

let voiceRejoin = false; // true = byliśmy na kanale głosowym, gdy zerwało się połączenie z serwerem
const analysers = new Map(); // 'me' lub socket.id -> { source, analyser, buf, speaking }
let speakingTimer = null;

function setSpeaking(key, speaking) {
  const id = key === 'me' ? socket.id : key;
  document.querySelectorAll('[data-voice-id]').forEach((node) => {
    if (node.dataset.voiceId === id) node.classList.toggle('speaking', speaking);
  });
}

function watchSpeaking(key, stream) {
  try {
    const ctx = getAudioCtx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    analysers.set(key, { source, analyser, buf: new Uint8Array(analyser.fftSize), speaking: false });
  } catch {
    return; // bez podświetlania mówiących czat głosowy nadal działa
  }
  if (speakingTimer) return;
  speakingTimer = setInterval(() => {
    analysers.forEach((a, key) => {
      a.analyser.getByteTimeDomainData(a.buf);
      let sum = 0;
      for (const v of a.buf) sum += ((v - 128) / 128) ** 2;
      const speaking = Math.sqrt(sum / a.buf.length) > 0.035 && !(key === 'me' && voice.muted);
      if (speaking !== a.speaking) {
        a.speaking = speaking;
        setSpeaking(key, speaking);
      }
    });
  }, 100);
}

function unwatchSpeaking(key) {
  const a = analysers.get(key);
  if (!a) return;
  try {
    a.source.disconnect();
  } catch {
    /* już odłączone */
  }
  analysers.delete(key);
  if (analysers.size === 0 && speakingTimer) {
    clearInterval(speakingTimer);
    speakingTimer = null;
  }
}

function renderVoiceUsers() {
  const list = voice.users;
  $('voice-count').textContent = list.length ? `${list.length}/${maxVoiceUsers}` : '';

  // Znaczki przy osobie: czerwone LIVE (udostępnia ekran) oraz wyciszenie / wyłączony dźwięk
  const flags = (u) => {
    const nodes = [];
    if (u.sharing) nodes.push(el('span', 'voice-live', 'LIVE'));
    if (u.deafened) nodes.push(el('span', 'voice-member__flags', '🙉'));
    else if (u.muted) nodes.push(el('span', 'voice-member__flags', '🔇'));
    return nodes;
  };

  $('voice-members').replaceChildren(
    ...list.map((u) => {
      const row = el('div', 'voice-member');
      row.dataset.voiceId = u.id;
      row.appendChild(makeAvatar(u.nick));
      row.appendChild(el('span', 'voice-member__name', u.nick));
      row.append(...flags(u));
      return row;
    })
  );

  $('voicebar-members').replaceChildren(
    ...list.map((u) => {
      const chip = el('div', 'voicebar__member');
      chip.dataset.voiceId = u.id;
      chip.appendChild(makeAvatar(u.nick));
      chip.appendChild(el('span', '', u.nick));
      chip.append(...flags(u));
      return chip;
    })
  );

  // Odtwórz podświetlenie osób, które mówią w tej chwili.
  analysers.forEach((a, key) => a.speaking && setSpeaking(key, true));
}

function updateVoiceUI() {
  $('voice-bar').classList.toggle('hidden', !voice.active);
  $('voice-btn').classList.toggle('is-active', voice.active);
  $('voice-btn').title = voice.active ? 'Rozłącz z kanałem głosowym' : 'Dołącz do kanału głosowego';
  $('voice-channel').classList.toggle('is-connected', voice.active);
  $('voice-mute').classList.toggle('is-off', voice.muted);
  $('voice-mute').title = voice.muted ? 'Włącz mikrofon' : 'Wycisz mikrofon';
  $('voice-deafen').classList.toggle('is-off', voice.deafened);
  $('voice-deafen').title = voice.deafened ? 'Włącz dźwięk' : 'Wyłącz dźwięk';
  $('voice-screen').classList.toggle('is-sharing', Boolean(voice.screen));
  $('voice-screen').title = voice.screen ? 'Zatrzymaj udostępnianie ekranu' : 'Udostępnij ekran';
  renderVoiceUsers();
}

function applyVoiceState() {
  voice.stream?.getAudioTracks().forEach((t) => (t.enabled = !voice.muted));
  voice.peers.forEach((p) => {
    if (p.audio) p.audio.muted = voice.deafened;
  });
  screens.forEach((s, key) => {
    if (key !== 'me') s.video.muted = voice.deafened; // dźwięk cudzego ekranu też wyciszamy
  });
  if (voice.active) {
    socket.emit('voice:state', { muted: voice.muted, deafened: voice.deafened, sharing: Boolean(voice.screen) });
  }
  updateVoiceUI();
}

// ---------- Udostępnianie ekranu ----------
// Obraz idzie tymi samymi połączeniami co głos (peer-to-peer), a do trwającej rozmowy dokładamy go
// przez ponowną negocjację. Podgląd każdego udostępnianego ekranu to „kafelek” nad czatem.
const screens = new Map(); // 'me' lub socket.id -> { tile, video }

function updateScreenView() {
  $('screen-view').classList.toggle('hidden', screens.size === 0);
}

function showScreen(key, stream, label) {
  let entry = screens.get(key);
  if (!entry) {
    const tile = el('div', 'screen-tile');
    tile.dataset.voiceId = key === 'me' ? '' : key;
    const bar = el('div', 'screen-tile__bar');
    const title = el('span', 'screen-tile__title');
    bar.appendChild(title);
    const full = el('button', 'icon-btn', '⛶');
    full.type = 'button';
    full.title = 'Pełny ekran';
    bar.appendChild(full);

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = key === 'me' || voice.deafened; // własny podgląd bez dźwięku (unikamy echa)

    const toggleFullscreen = () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else tile.requestFullscreen?.().catch(() => {});
    };
    full.addEventListener('click', toggleFullscreen);
    video.addEventListener('dblclick', toggleFullscreen);

    tile.append(bar, video);
    $('screen-view').appendChild(tile);
    entry = { tile, video, title };
    screens.set(key, entry);
  }
  entry.title.textContent = label;
  if (entry.video.srcObject !== stream) entry.video.srcObject = stream;
  entry.video.play().catch(() => {});
  updateScreenView();
}

function removeScreen(key) {
  const entry = screens.get(key);
  if (!entry) return;
  entry.video.srcObject = null;
  entry.tile.remove();
  screens.delete(key);
  updateScreenView();
}

// Limit przepływności: nadawca wysyła obraz osobno do każdego widza, więc im więcej osób, tym mniej na osobę.
async function applyScreenBitrate(peer) {
  const bps = Math.max(500_000, Math.min(2_500_000, Math.floor(6_000_000 / Math.max(1, voice.peers.size))));
  for (const sender of peer.screenSenders) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = bps;
      await sender.setParameters(params);
    } catch {
      /* przeglądarka nie pozwala – zostaje domyślna przepływność */
    }
  }
}

function addScreenTracks(peer) {
  if (!voice.screen || peer.screenSenders.length) return;
  peer.screenSenders = voice.screen.getTracks().map((track) => peer.pc.addTrack(track, voice.screen));
}

async function startScreenShare() {
  if (!voice.active || voice.screen) return;
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return toast('Ta przeglądarka nie obsługuje udostępniania ekranu (na telefonach zwykle jest niedostępne).');
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: true });
  } catch (err) {
    if (err.name !== 'NotAllowedError') toast('Nie udało się rozpocząć udostępniania ekranu.');
    return; // anulowanie w oknie wyboru nie jest błędem
  }
  if (!voice.active) return stream.getTracks().forEach((t) => t.stop()); // w międzyczasie opuszczono kanał

  voice.screen = stream;
  // Użytkownik może zakończyć udostępnianie przyciskiem przeglądarki („Przestań udostępniać”).
  stream.getVideoTracks()[0].addEventListener('ended', stopScreenShare);
  voice.peers.forEach(addScreenTracks);
  showScreen('me', stream, 'Twój ekran');
  applyVoiceState();
}

function stopScreenShare() {
  if (!voice.screen) return;
  const stream = voice.screen;
  voice.screen = null;
  voice.peers.forEach((peer) => {
    peer.screenSenders.forEach((sender) => {
      try {
        peer.pc.removeTrack(sender);
      } catch {
        /* połączenie już zamknięte */
      }
    });
    peer.screenSenders = [];
  });
  stream.getTracks().forEach((t) => t.stop());
  removeScreen('me');
  applyVoiceState();
}

function closePeer(id) {
  const peer = voice.peers.get(id);
  if (!peer) return;
  peer.pc.onicecandidate = peer.pc.ontrack = peer.pc.onconnectionstatechange = null;
  peer.pc.onnegotiationneeded = peer.pc.onsignalingstatechange = null;
  peer.pc.close();
  peer.audio?.remove();
  unwatchSpeaking(id);
  removeScreen(id);
  voice.peers.delete(id);
}

function sendSdp(to, description) {
  socket.emit('voice:signal', { to, data: { sdp: { type: description.type, sdp: description.sdp } } });
}

function createPeer(id) {
  const pc = new RTCPeerConnection({ iceServers });
  const peer = {
    pc,
    pending: [], // kandydaci ICE, którzy dotarli przed opisem sesji
    audio: null,
    micStreamId: null, // strumień z mikrofonem tej osoby; każdy inny to udostępniany ekran
    screenSenders: [], // nasze nadajniki ekranu do tej osoby
    // „Perfect negotiation”: gdy obie strony wyślą ofertę naraz, jedna (uprzejma) ustępuje.
    polite: socket.id > id,
    makingOffer: false,
    ignoreOffer: false,
    negotiationEnabled: false, // pierwsza wymiana (mikrofony) idzie osobną ścieżką, potem negocjujemy zmiany
  };

  // Zmiany w trakcie rozmowy (np. dołożenie obrazu ekranu) wymagają nowej oferty.
  pc.onnegotiationneeded = async () => {
    if (!peer.negotiationEnabled) return;
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      sendSdp(id, pc.localDescription);
    } catch (err) {
      console.warn('Błąd negocjacji połączenia głosowego:', err);
    } finally {
      peer.makingOffer = false;
    }
  };
  pc.onsignalingstatechange = () => {
    if (pc.signalingState === 'stable' && peer.screenSenders.length) applyScreenBitrate(peer);
  };

  voice.stream.getTracks().forEach((track) => pc.addTrack(track, voice.stream));

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('voice:signal', { to: id, data: { candidate: e.candidate.toJSON() } });
  };
  pc.ontrack = (e) => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    // Pierwszy dźwięk od tej osoby to mikrofon; wszystko inne (obraz i dźwięk ekranu) trafia do kafelka.
    const isMic = e.track.kind === 'audio' && (peer.micStreamId === null || peer.micStreamId === stream.id);
    if (!isMic) {
      const owner = voice.users.find((u) => u.id === id);
      showScreen(id, stream, `${owner ? owner.nick : 'Ktoś'} udostępnia ekran`);
      return;
    }
    peer.micStreamId = stream.id;
    if (!peer.audio) {
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.playsInline = true;
      audio.muted = voice.deafened;
      $('voice-audio').appendChild(audio);
      peer.audio = audio;
    }
    peer.audio.srcObject = stream;
    peer.audio.play().catch(() => {});
    if (!analysers.has(id)) watchSpeaking(id, stream);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      toast('Nie udało się połączyć głosowo z jedną z osób (sieć może wymagać serwera TURN).');
    }
  };

  voice.peers.set(id, peer);
  return peer;
}

// Po pierwszej wymianie ofert włączamy negocjację zmian i dokładamy ekran, jeśli właśnie go udostępniamy.
function enableNegotiation(peer) {
  peer.negotiationEnabled = true;
  addScreenTracks(peer);
}

async function callPeer(id) {
  const peer = createPeer(id);
  await peer.pc.setLocalDescription(await peer.pc.createOffer());
  sendSdp(id, peer.pc.localDescription);
}

async function flushCandidates(peer) {
  for (const c of peer.pending.splice(0)) {
    await peer.pc.addIceCandidate(c).catch(() => {});
  }
}

socket.on('voice:signal', async ({ from, data }) => {
  if (!voice.active || !data) return;
  try {
    let peer = voice.peers.get(from);

    if (data.sdp) {
      const description = data.sdp;
      if (description.type === 'offer') {
        peer = peer || createPeer(from);
        // Kolizja: obie strony wysłały ofertę naraz. Nieuprzejma ignoruje cudzą, uprzejma się wycofuje.
        const collision = peer.makingOffer || peer.pc.signalingState !== 'stable';
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;

        await peer.pc.setRemoteDescription(description); // uprzejma strona automatycznie wycofuje własną ofertę
        await flushCandidates(peer);
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        sendSdp(from, peer.pc.localDescription);
        enableNegotiation(peer);
      } else if (description.type === 'answer' && peer) {
        if (peer.pc.signalingState !== 'have-local-offer') return; // spóźniona lub zbędna odpowiedź
        await peer.pc.setRemoteDescription(description);
        await flushCandidates(peer);
        enableNegotiation(peer);
      }
    } else if (data.candidate && peer) {
      if (peer.pc.remoteDescription) {
        try {
          await peer.pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!peer.ignoreOffer) console.warn('Kandydat ICE odrzucony:', err);
        }
      } else {
        peer.pending.push(data.candidate); // kandydat przyszedł przed ofertą/odpowiedzią
      }
    }
  } catch (err) {
    console.warn('Błąd sygnalizacji głosowej:', err);
  }
});

function stopLocalStream() {
  voice.stream?.getTracks().forEach((t) => t.stop());
  voice.stream = null;
}

async function joinVoice() {
  if (voice.active || voice.joining || !myNick) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    return toast('Czat głosowy wymaga połączenia HTTPS i nowszej przeglądarki.');
  }

  voice.joining = true;
  try {
    voice.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (err) {
    voice.joining = false;
    return toast(
      err.name === 'NotAllowedError'
        ? 'Brak zgody na mikrofon – zezwól na jego użycie w ustawieniach przeglądarki.'
        : err.name === 'NotFoundError'
          ? 'Nie znaleziono mikrofonu.'
          : 'Nie udało się uruchomić mikrofonu.'
    );
  }

  socket.timeout(10000).emit('voice:join', (err, res) => {
    voice.joining = false;
    if (err || !res || !res.ok) {
      stopLocalStream();
      return toast((res && res.error) || 'Nie udało się dołączyć do kanału głosowego.');
    }
    voice.active = true;
    voice.muted = false;
    voice.deafened = false;
    watchSpeaking('me', voice.stream);
    res.peers.forEach((id) => callPeer(id).catch((e) => console.warn('Błąd połączenia głosowego:', e)));
    updateVoiceUI();
  });
}

function leaveVoice(notify = true) {
  if (!voice.active && !voice.stream) return;
  if (notify && voice.active && socket.connected) socket.emit('voice:leave');
  if (voice.screen) {
    voice.screen.getTracks().forEach((t) => t.stop());
    voice.screen = null;
    removeScreen('me');
  }
  Array.from(voice.peers.keys()).forEach(closePeer);
  unwatchSpeaking('me');
  stopLocalStream();
  voice.active = false;
  voice.muted = false;
  voice.deafened = false;
  document.querySelectorAll('.speaking').forEach((n) => n.classList.remove('speaking'));
  updateVoiceUI();
}

socket.on('voice:users', (list) => {
  const previous = voice.users.length;
  voice.users = list;
  if (voice.active) {
    const ids = new Set(list.map((u) => u.id));
    Array.from(voice.peers.keys()).forEach((id) => {
      if (!ids.has(id)) closePeer(id);
    });
    // Osoba przestała udostępniać ekran – zamykamy jej kafelek.
    list.forEach((u) => {
      if (!u.sharing) removeScreen(u.id);
    });
    if (list.length > previous) beep([660, 880]);
    else if (list.length < previous) beep([520, 380]);
  }
  renderVoiceUsers();
});

$('voice-channel').addEventListener('click', joinVoice);
$('voice-btn').addEventListener('click', () => (voice.active ? leaveVoice() : joinVoice()));
$('voice-leave').addEventListener('click', () => leaveVoice());
$('voice-screen').addEventListener('click', () => (voice.screen ? stopScreenShare() : startScreenShare()));
// Na urządzeniach bez udostępniania ekranu (np. telefony) ukrywamy przycisk – oglądanie cudzego ekranu działa.
if (!navigator.mediaDevices?.getDisplayMedia) $('voice-screen').classList.add('hidden');
$('voice-mute').addEventListener('click', () => {
  if (voice.deafened) {
    voice.deafened = false;
    voice.muted = false;
  } else {
    voice.muted = !voice.muted;
  }
  applyVoiceState();
});
$('voice-deafen').addEventListener('click', () => {
  voice.deafened = !voice.deafened;
  voice.muted = voice.deafened; // jak na Discordzie: wyłączenie dźwięku wycisza też mikrofon
  applyVoiceState();
});

// ---------- Zdarzenia z serwera ----------
let historyLoading = false; // w trakcie wczytywania historii nowe wiadomości czekają w kolejce
const pendingLive = [];
let serverHistory = [];
let archiveLimit = 300; // ile najnowszych wiadomości z archiwum pokazujemy

function handleLive(m) {
  logMessage(m);
  archiveSave(m);
  addMessage(m);
}

socket.on('message', (m) => {
  if ((m.channel || DEFAULT_CHANNEL) !== currentChannel) return;
  if (historyLoading) pendingLive.push(m);
  else handleLive(m);
});
socket.on('system', addSystem);

// Nowa wiadomość na kanale, którego akurat nie oglądasz – zapalamy kropkę przy jego nazwie.
socket.on('activity', ({ channel }) => {
  if (channel === currentChannel) return;
  unreadChannels.add(channel);
  renderChannels();
});

// ---------- Kanały tekstowe: lista, przełączanie, bramka wiekowa ----------
function channelById(id) {
  return channels.find((c) => c.id === id) || channels[0];
}

function renderChannels() {
  const current = channelById(currentChannel);

  $('channel-list').replaceChildren(
    ...channels.map((c) => {
      const active = c.id === currentChannel;
      const unread = unreadChannels.has(c.id) && !active;
      const item = el('button', 'channel' + (active ? ' channel--active' : '') + (unread ? ' channel--unread' : ''));
      item.type = 'button';
      item.dataset.channel = c.id;
      item.appendChild(el('span', 'hash', '#'));
      item.appendChild(document.createTextNode(` ${c.name}`));
      if (c.nsfw) item.appendChild(el('span', 'channel__badge', '18+'));
      else if (unread) item.appendChild(el('span', 'channel__dot'));
      item.addEventListener('click', () => switchChannel(c.id));
      return item;
    })
  );

  const select = $('channel-select');
  select.replaceChildren(
    ...channels.map((c) => {
      const opt = el('option', '', `# ${c.name}${c.nsfw ? ' (18+)' : ''}${unreadChannels.has(c.id) && c.id !== currentChannel ? ' •' : ''}`);
      opt.value = c.id;
      return opt;
    })
  );
  select.value = currentChannel;

  $('channel-title').textContent = current.name;
  messageInput.placeholder = `Napisz wiadomość na #${current.name}`;
  messagesEl.dataset.nsfw = current.nsfw ? '1' : '';
}

$('channel-select').addEventListener('change', (e) => switchChannel(e.target.value));

function showAgeGate(onConfirm) {
  const gate = $('age-gate');
  gate.classList.remove('hidden');
  $('age-no').onclick = () => gate.classList.add('hidden');
  $('age-yes').onclick = () => {
    gate.classList.add('hidden');
    adultConfirmed = true;
    store.set('mychat.adult', { ok: true });
    onConfirm();
  };
}

function switchChannel(id) {
  if (id === currentChannel || !channels.some((c) => c.id === id)) return renderChannels();
  const target = channelById(id);
  if (target.nsfw && !adultConfirmed) {
    renderChannels(); // przywraca poprzedni wybór na liście (telefon)
    return showAgeGate(() => switchChannel(id));
  }
  if (!socket.connected) {
    renderChannels();
    return toast('Brak połączenia z serwerem.');
  }

  const previous = currentChannel;
  currentChannel = id;
  historyLoading = true; // nowe wiadomości czekają, aż przyjdzie historia tego kanału
  pendingLive.length = 0;
  unreadChannels.delete(id);
  typingUsers.clear();
  renderTyping();
  messagesEl.replaceChildren();
  lastNick = null;
  lastDay = null;
  archiveLimit = 300;
  store.set('mychat.channel', { id });
  renderChannels();
  closePopups();

  socket.timeout(10000).emit('switchChannel', { channel: id, adult: adultConfirmed }, (err, res) => {
    if (!err && res && res.ok) return;
    // Nie udało się – wracamy na poprzedni kanał.
    if (res && res.needAdult) {
      adultConfirmed = false;
      store.set('mychat.adult', { ok: false });
    }
    toast((res && res.error) || 'Nie udało się zmienić kanału.');
    historyLoading = false;
    if (currentChannel === id) switchChannel(previous);
  });
}

// Usunięta wiadomość znika wszędzie: z ekranu, z pamięci sesji i z archiwum lokalnego (razem z plikiem).
async function applyDeletions(ids) {
  ids.forEach((id) => {
    removeMessageNode(id);
    sessionLog.delete(id);
    localFileIds.delete(id);
  });
  try {
    await archive.opening;
    await archive.removeMany(ids);
  } catch (err) {
    handleArchiveError(err);
  }
}

socket.on('messageDeleted', (id) => applyDeletions([id]));

// Wiadomości usunięte, gdy byłeś offline, serwer zna z listy usunięć. Po zalogowaniu czyścimy z nich archiwum.
function syncDeletions() {
  const since = store.get('mychat.deletedSync', { at: 0 }).at || 0;
  socket.timeout(15000).emit('sync:deleted', since, async (err, res) => {
    if (err || !res || !res.ok) return; // spróbujemy przy następnym logowaniu
    await applyDeletions(res.ids);
    store.set('mychat.deletedSync', { at: res.now });
  });
}

function mergeById(...lists) {
  const map = new Map();
  lists.forEach((list) => list.forEach((m) => map.set(m.id, m)));
  return Array.from(map.values()).sort((a, b) => a.time - b.time);
}

// Rysuje czat: wiadomości z serwera (ostatnie dni) połączone z archiwum lokalnym (wszystko, co zapisano).
async function renderChat() {
  if (identityBackfill) await identityBackfill; // najpierw ustalamy, które stare wiadomości są Twoje (ikona kosza)
  let list = serverHistory;
  let hasOlder = false;

  if (settings.archive && archive.ready) {
    try {
      const channel = currentChannel;
      const local = await archive.recent(channel, archiveLimit);
      hasOlder = (await archive.countChannel(channel)) > local.length;
      list = mergeById(local, serverHistory);
    } catch (err) {
      handleArchiveError(err);
    }
  }

  messagesEl.replaceChildren();
  lastNick = null;
  lastDay = null;
  lastMessageTime = 0;

  const days = retentionDays === 1 ? '1 dniu' : `${retentionDays} dniach`;
  const archived = settings.archive && archive.ready;
  messagesEl.appendChild(
    el(
      'div',
      'system system--info',
      `Na serwerze wiadomości i pliki są usuwane po ${days}.` +
        (archived ? ' Archiwum lokalne zachowuje je na tym urządzeniu.' : ' Włącz archiwum lokalne w ustawieniach, aby je zachować.')
    )
  );

  if (hasOlder) {
    const btn = el('button', 'loadolder', 'Pokaż starsze wiadomości z archiwum');
    btn.type = 'button';
    btn.addEventListener('click', () => {
      const before = { height: messagesEl.scrollHeight, top: messagesEl.scrollTop };
      archiveLimit += 300;
      renderChat().then(() => {
        messagesEl.scrollTop = messagesEl.scrollHeight - before.height + before.top;
      });
    });
    messagesEl.appendChild(btn);
  }

  list.forEach((m) => addMessage(m, { historic: true }));
  sweepExpired();
  scrollToBottom();
}

// Historia z ostatnich dni – przychodzi po (ponownym) dołączeniu do czatu.
socket.on('history', async ({ channel, messages, styles = {} }) => {
  if (channel !== currentChannel) return; // spóźniona historia kanału, który już opuściłeś
  historyLoading = true;
  for (const [accountId, style] of Object.entries(styles)) setNickStyle(accountId, null, style);
  const list = messages.map((m) => ({ ...m, channel: m.channel || channel }));
  try {
    await archive.opening;
    if (archive.ready && !localFileIds.size) {
      (await archive.fileIds()).forEach((id) => localFileIds.add(id));
    }
    serverHistory = list;
    list.forEach(logMessage);
    if (settings.archive && archive.ready) await archive.put(list.map(slimMessage));
  } catch (err) {
    handleArchiveError(err);
  }
  if (channel !== currentChannel) return; // w międzyczasie przełączono kanał
  try {
    await renderChat();
  } catch (err) {
    console.warn('Nie udało się narysować historii:', err);
  }
  if (channel !== currentChannel) return;
  historyLoading = false;
  pendingLive.splice(0).forEach(handleLive);
});
socket.on('users', renderMembers);

socket.on('typing', ({ nick, isTyping, channel }) => {
  if (channel && channel !== currentChannel) return;
  if (isTyping) typingUsers.add(nick);
  else typingUsers.delete(nick);
  renderTyping();
});

socket.on('connect', () => {
  statusEl.textContent = 'połączono';
  // Zapamiętane konto loguje się samo – także po utracie połączenia (np. uśpieniu serwera na Renderze).
  const nick = myNick || profile.nick;
  if (nick) join(nick);
});

socket.on('disconnect', () => {
  if (voice.active) {
    voiceRejoin = true; // wrócimy na kanał, gdy tylko uda się zalogować ponownie
    leaveVoice(false);
    toast('Utracono połączenie z serwerem – próbuję wrócić na kanał głosowy…');
  }
  voice.users = [];
  renderVoiceUsers();
  statusEl.textContent = 'rozłączono – próba ponownego połączenia…';
  typingUsers.clear();
  renderTyping();
});

// ---------- Start ----------
applySettings();
nickInput.value = profile.nick || '';
updateLoginAvatar();
if (profile.nick) showAutoLogin(profile.nick); // zapamiętane konto – logujemy się automatycznie

fetch('/api/config')
  .then((r) => r.json())
  .then((cfg) => {
    gifSearchEnabled = Boolean(cfg.gifSearch);
    if (cfg.maxFileBytes) maxFileBytes = cfg.maxFileBytes;
    if (Array.isArray(cfg.iceServers) && cfg.iceServers.length) iceServers = cfg.iceServers;
    if (cfg.maxVoiceUsers) maxVoiceUsers = cfg.maxVoiceUsers;
    if (cfg.gifAvatarBytes) gifAvatarBytes = cfg.gifAvatarBytes;
    if (cfg.gifBannerBytes) gifBannerBytes = cfg.gifBannerBytes;
    if (cfg.retentionMs) {
      retentionMs = cfg.retentionMs;
      retentionDays = cfg.retentionDays;
    }
  })
  .catch(() => {});

// Co 10 minut sprawdzamy, czy jakieś wiadomości na ekranie nie wygasły (np. przy długo otwartej karcie).
setInterval(sweepExpired, 10 * 60 * 1000);
