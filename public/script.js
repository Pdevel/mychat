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
  { id: 'red', name: 'Czerwony', colors: ['#260b0f', '#3b1218', '#4a1a21'], accent: '#ed4245' },
  { id: 'amber', name: 'Bursztyn', colors: ['#1a1208', '#271a0b', '#302210'], accent: '#ff9f1a' },
  { id: 'burgundy', name: 'Bordo', colors: ['#1e0a14', '#2e0f1f', '#381427'], accent: '#e0457b' },
  { id: 'violet', name: 'Fiolet', colors: ['#130d24', '#1d1435', '#251a42'], accent: '#a07bff' },
];
const DEFAULT_ACCENT = '#5865f2';
const ACCENTS = ['#5865f2', '#3ba55d', '#eb459e', '#ed4245', '#faa61a', '#1abc9c', '#9b59b6'];

let settings = store.get('mychat.settings', {
  theme: 'dark',
  accent: '#5865f2',
  sound: true,
  screenQuality: 'high', // jakość udostępniania ekranu: low | standard | high | ultra
  screenMode: 'motion', // 'motion' = płynność, 'detail' = ostrość
  screenAudio: 'on', // dźwięk karty przy udostępnianiu ekranu: 'on' | 'off'
  archive: true, // zapisuj wiadomości na tym urządzeniu (nie znikają po okresie przechowywania na serwerze)
  archiveFiles: false, // zapisuj też zawartość plików (zajmuje więcej miejsca)
  partyGlow: 'image', // poświata trybu kinowego: 'image' (według obrazu, gdzie się da) | 'steady' | 'off'
  partySounds: false, // dźwięki seansu: tykanie odliczania, start, reakcje
  partyVoice: false, // przy wspólnym seansie dołącz do kanału głosowego i wycisz dźwięki aplikacji
  keepAwake: true, // nie wygaszaj ekranu, gdy gra film w odtwarzaczu
  discreet: false, // tryb dyskretny: neutralna karta, ukrywanie multimediów klawiszem H i przy zmianie karty
  partyEmoji: '🔥😍👏😂❤️😮', // własne reakcje na żywo (do 8)
  oneHand: 'off', // tryb jednej ręki na telefonie: 'off' | 'left' | 'right'
});
// avatar = adres obrazu z serwera; avatarData = mała lokalna kopia (pozwala odtworzyć avatar po zresetowaniu serwera)
let profile = store.get('mychat.profile', { nick: '', avatar: null, avatarData: null });
if (profile.avatar && profile.avatar.startsWith('data:')) {
  // starszy format: avatar był zapisany jako data-URL
  profile.avatarData = profile.avatarData || profile.avatar;
  profile.avatar = null;
}

// Wersje do sprawdzenia, czy telefon pobrał nową stronę i czy serwer jest po wdrożeniu.
const CLIENT_VERSION = '2026-10-10m';
let serverInfo = null;
function renderVersionInfo() {
  const server = serverInfo ? `serwer: ${serverInfo.version}${serverInfo.party ? '' : ' (STARSZY – brak seansów, wdróż ponownie)'}` : 'serwer: sprawdzam…';
  const text = `Wersja strony: ${CLIENT_VERSION} · ${server}`;
  const note = $('version-note');
  if (note) note.textContent = text;
  const login = $('login-version');
  if (login) login.textContent = text;
}

renderVersionInfo();

let myNick = null;
let myAccountId = null;

// Kanały tekstowe istnieją tylko w grupach (nie ma już kanałów wspólnych dla wszystkich).
const isGroupChannel = (id) => typeof id === 'string' && id.startsWith('g_');
let currentChannel = (() => {
  const saved = store.get('mychat.channel', { id: null }).id;
  return isGroupChannel(saved) ? saved : null; // null = nie oglądasz żadnego kanału (np. jeszcze nie masz grupy)
})();
let groups = []; // grupy, do których należysz – tylko w pamięci, zawsze z serwera (nigdy zapisywane lokalnie)
let serverSynced = false; // true dopiero po zalogowaniu, gdy lista grup jest świeża; po zerwaniu połączenia znów false
const lastGroupChannel = new Map(); // grupa -> ostatnio oglądany w niej kanał
const unreadChannels = new Set(); // kanały z nowymi wiadomościami, których nie oglądasz
const mentionCounts = new Map(); // kanał -> ile razy oznaczono Cię tam, gdy go nie oglądałeś
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

// Pomocnicze elementy z ikonami (zestaw w icons.js): podpis i ikona po prawej oraz znaczek przy osobie w kanale głosowym.
function textWithIcon(text, name) {
  const span = el('span', 'text-icon', `${text} `);
  span.appendChild(icon(name));
  return span;
}

function voiceFlag(name, title) {
  const flag = iconNode('span', 'voice-member__flags', name);
  flag.title = title;
  return flag;
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
        // Motyw może mieć własny kolor akcentu (np. czerwony) – ustawiamy go, o ile nie wybrano innego.
        if (t.accent && settings.accent === DEFAULT_ACCENT) settings.accent = t.accent;
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
  $('screen-quality').value = settings.screenQuality;
  $('screen-mode').value = settings.screenMode;
  $('screen-audio').value = settings.screenAudio;
  $('archive-toggle').checked = settings.archive;
  $('party-glow').value = settings.partyGlow;
  $('one-hand').value = settings.oneHand;
  $('party-emoji').value = settings.partyEmoji;
  $('party-sounds-toggle').checked = settings.partySounds;
  $('party-voice-toggle').checked = settings.partyVoice;
  $('keep-awake-toggle').checked = settings.keepAwake;
  $('discreet-toggle').checked = settings.discreet;
  $('archive-files-toggle').checked = settings.archiveFiles;
  $('archive-files-toggle').disabled = !settings.archive;
}

// ---------- Avatary ----------
// Dozwolone źródła obrazu: adres z serwera (/media/…) albo data-URL wybrany lokalnie (także animowany GIF).
const MEDIA_URL = /^\/media\/(avatar|banner|emoji|group)\/[0-9a-f-]{12,36}\?v=[0-9a-f]+$/;
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
// ---------- Własne emoji serwera ----------
// Wspólne dla wszystkich (jak na Discordzie): w wiadomości wpisujesz :nazwa:, a pod wiadomością możesz dać reakcję.
let customEmoji = []; // [{ id, name, url, animated, by, byId }]
let maxEmoji = 100;
const emojiByName = new Map(); // nazwa małymi literami -> emoji

function setCustomEmoji(list) {
  customEmoji = Array.isArray(list) ? list : [];
  emojiByName.clear();
  customEmoji.forEach((e) => emojiByName.set(e.name.toLowerCase(), e));
}

function emojiImg(emoji, big) {
  const img = el('img', 'emoji' + (big ? ' emoji--big' : ''));
  img.src = emoji.url;
  img.alt = `:${emoji.name}:`;
  img.title = `:${emoji.name}:`;
  img.draggable = false;
  img.loading = 'lazy';
  return img;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Zwykły tekst z wzmiankami: „@Nick” osoby wymienionej w wiadomości staje się klikalną plakietką.
// Lista osób pochodzi z serwera (m.mentions) – tylko one są podświetlane.
function appendTextWithMentions(frag, text, mentions) {
  const named = (mentions || []).filter((m) => !m.reply && m.nick);
  if (!named.length || !text.includes('@')) {
    if (text) frag.appendChild(document.createTextNode(text));
    return;
  }
  const names = named.map((m) => escapeRegExp(m.nick)).sort((a, b) => b.length - a.length); // najdłuższe pierwsze
  const pattern = new RegExp(`@(${names.join('|')})`, 'giu');
  let last = 0;
  let match;
  while ((match = pattern.exec(text))) {
    const before = text[match.index - 1];
    const after = text[match.index + match[0].length];
    if ((before && WORD_CHAR.test(before)) || (after && WORD_CHAR.test(after))) continue; // „ala@x.pl”, „@Ania2”
    const person = named.find((m) => m.nick.toLowerCase() === match[1].toLowerCase());
    if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
    const chip = el('span', 'mention', match[0]);
    markProfileTrigger(chip, person.nick, person.id);
    if (identity.accountIds.has(person.id)) chip.classList.add('mention--me');
    frag.appendChild(chip);
    last = match.index + match[0].length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
}

// Tekst wiadomości: linki są klikalne, :nazwa: znanego emoji zamienia się w obrazek, a @nick w plakietkę wzmianki.
function renderRichText(text, big = false, mentions = []) {
  const frag = document.createDocumentFragment();
  text.split(/(https?:\/\/[^\s<>"']+)/g).forEach((part, i) => {
    if (i % 2 === 1) {
      const a = el('a', '', part);
      a.href = part;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      frag.appendChild(a);
      return;
    }
    part.split(/(:[A-Za-z0-9_]{2,32}:)/g).forEach((piece, j) => {
      if (j % 2 === 1) {
        const emoji = emojiByName.get(piece.slice(1, -1).toLowerCase());
        if (emoji && isSafeImageSrc(emoji.url)) return frag.appendChild(emojiImg(emoji, big));
      }
      appendTextWithMentions(frag, piece, mentions);
    });
  });
  return frag;
}

// Wiadomość złożona wyłącznie z 1–8 emoji (zwykłych lub własnych) wyświetlamy powiększoną, jak na Discordzie.
function isJumboMessage(text) {
  let customCount = 0;
  const rest = text.replace(/:([A-Za-z0-9_]{2,32}):/g, (match, name) => {
    if (!emojiByName.has(name.toLowerCase())) return match;
    customCount += 1;
    return '';
  });
  const unicodeCount = (rest.match(/\p{Extended_Pictographic}/gu) || []).length;
  const leftovers = rest.replace(/[\p{Extended_Pictographic}‍️\s]/gu, '');
  const total = customCount + unicodeCount;
  return leftovers === '' && total >= 1 && total <= 8;
}

// ---------- Wideo z linków (miniodtwarzacz jak na Discordzie) ----------
// Rozpoznajemy YouTube, Vimeo i bezpośrednie pliki wideo. Nic nie ładujemy z cudzych serwisów
// (poza miniaturą YouTube), dopóki ktoś nie kliknie „Odtwórz”.
const DIRECT_VIDEO = /\.(mp4|webm|ogv|mov|m4v)$/i;
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

function parseVideoLink(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be' || host === 'youtube.com' || host === 'youtube-nocookie.com') {
    let id = host === 'youtu.be' ? u.pathname.slice(1).split('/')[0] : u.searchParams.get('v');
    const path = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
    if (!id && path) id = path[1];
    if (!id || !YT_ID.test(id)) return null;
    const start = parseInt(u.searchParams.get('t') || u.searchParams.get('start') || '', 10);
    const query = `autoplay=1&rel=0${start > 0 ? `&start=${start}` : ''}`;
    const short = /^\/shorts\//.test(u.pathname);
    return {
      kind: 'iframe',
      provider: 'youtube',
      short,
      label: short ? 'YouTube Shorts' : 'YouTube',
      src: `https://www.youtube-nocookie.com/embed/${id}?${query}`,
      thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      href,
    };
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = u.pathname.match(/\/(?:video\/)?(\d{5,12})(?:\/([0-9a-f]{8,}))?\/?$/);
    if (!m) return null;
    const hash = m[2] || u.searchParams.get('h');
    const src = `https://player.vimeo.com/video/${m[1]}?autoplay=1${hash && /^[0-9a-f]+$/.test(hash) ? `&h=${hash}` : ''}`;
    return { kind: 'iframe', provider: 'vimeo', label: 'Vimeo', src, thumb: '', href };
  }
  if (DIRECT_VIDEO.test(u.pathname)) {
    return { kind: 'video', provider: 'file', label: u.hostname, src: u.href, thumb: '', href };
  }
  return null;
}

// Adres filmu od podanej sekundy (YouTube, Vimeo i pliki wideo).
function videoSrcAt(video, sec) {
  const at = Math.floor(sec);
  if (!(at > 0)) return video.src;
  try {
    const u = new URL(video.src);
    if (video.provider === 'youtube') u.searchParams.set('start', String(at));
    else if (video.provider === 'vimeo') u.hash = `t=${at}s`;
    else if (video.provider === 'file') u.hash = `t=${at}`;
    else return video.src;
    return u.href;
  } catch {
    return video.src;
  }
}

// Element odtwarzacza: iframe (YouTube/Vimeo) albo <video> z własnymi kontrolkami.
// `ambient`: próbujemy wczytać plik z CORS, żeby dało się odczytać kolory obrazu do poświaty (bez CORS wracamy do zwykłego).
function makePlayerNode(video, className, { startSec = 0, ambient = false } = {}) {
  if (video.kind === 'video') {
    const v = el('video', className);
    v.controls = true;
    v.autoplay = true;
    v.preload = 'metadata';
    v.referrerPolicy = 'no-referrer';
    const src = videoSrcAt(video, startSec);
    if (ambient) {
      v.crossOrigin = 'anonymous';
      v.addEventListener(
        'error',
        () => {
          if (!v.crossOrigin) return;
          v.removeAttribute('crossorigin'); // serwer nie wysyła CORS – gramy bez odczytu kolorów
          v.src = src;
        },
        { once: true }
      );
    }
    v.src = src;
    return v;
  }
  const frame = el('iframe', className);
  const at = startSec > 0 ? { ...video, src: videoSrcAt(video, startSec) } : video;
  frame.src = at.src;
  frame.title = `${video.label} – odtwarzacz`;
  frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  frame.allowFullscreen = true;
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-popups');
  return frame;
}

// Karta pod wiadomością: miniatura + „Odtwórz tutaj” (w wiadomości) albo „Mały odtwarzacz” (pływające okienko).
function makeVideoEmbed(video, afterChange) {
  const cur = video;
  const card = el('div', 'vembed');
  const stage = el('div', 'vembed__stage');
  const header = el('div', 'vembed__bar');
  const label = iconNode('span', 'vembed__label', 'play', '');
  const labelText = label.appendChild(document.createTextNode(''));
  header.appendChild(label);
  const actions = el('div', 'vembed__actions');

  const popBtn = iconNode('button', 'vembed__btn', 'popout', 'Mały odtwarzacz');
  popBtn.type = 'button';
  popBtn.title = 'Oglądaj w pływającym oknie – zostaje przy zmianie kanału';
  popBtn.addEventListener('click', () => {
    showStage(false);
    openMiniPlayer(cur);
  });
  const partyBtn = iconNode('button', 'vembed__btn', 'users');
  partyBtn.type = 'button';
  partyBtn.title = 'Oglądajmy razem – zaproś kanał, wspólny start 3-2-1';
  partyBtn.setAttribute('aria-label', partyBtn.title);
  partyBtn.addEventListener('click', () => openPartyChooser(partyBtn, cur));
  const favBtn = iconNode('button', 'vembed__btn', 'star');
  favBtn.type = 'button';
  bindFavButton(favBtn, () => cur);
  const stopBtn = iconNode('button', 'vembed__btn hidden', 'close', 'Zatrzymaj');
  stopBtn.type = 'button';
  stopBtn.title = 'Zatrzymaj i schowaj odtwarzacz';
  stopBtn.addEventListener('click', () => {
    showStage(false);
    afterChange();
  });
  const openBtn = iconNode('a', 'vembed__btn', 'external');
  openBtn.target = '_blank';
  openBtn.rel = 'noopener noreferrer';
  openBtn.title = 'Otwórz w nowej karcie';
  actions.append(stopBtn, favBtn, partyBtn, popBtn, openBtn);
  header.appendChild(actions);

  // Klasy karty zależą od serwisu i od tego, czy to short (układ pionowy).
  const sync = () => {
    card.className = `vembed vembed--${cur.provider}${cur.short ? ' vembed--short' : ''}`;
    labelText.textContent = ` ${cur.label}`;
    openBtn.href = cur.href;
    document.dispatchEvent(new CustomEvent('favs-changed')); // gwiazdka pokazuje stan nowego filmu
  };
  const showStage = (playing) => {
    stage.replaceChildren();
    stopBtn.classList.toggle('hidden', !playing);
    if (playing) {
      stage.appendChild(makePlayerNode(cur, 'vembed__player'));
      closeMiniPlayer();
    } else {
      const poster = el('button', 'vembed__poster');
      poster.type = 'button';
      poster.setAttribute('aria-label', `Odtwórz wideo (${cur.label})`);
      if (cur.thumb) {
        const img = el('img', 'vembed__thumb');
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        img.alt = '';
        img.addEventListener('load', afterChange);
        img.addEventListener('error', () => img.remove());
        img.src = cur.thumb;
        poster.appendChild(img);
      }
      poster.appendChild(iconNode('span', 'vembed__play', 'play'));
      poster.addEventListener('click', () => {
        showStage(true);
        afterChange();
      });
      stage.appendChild(poster);
    }
  };
  sync();
  showStage(false);
  card.append(header, stage);
  return card;
}

// ---------- Ulubione ----------
// Filmy zapisane gwiazdką – lista tylko na tym urządzeniu (do 50 pozycji), dostępna jako osobna playlista w odtwarzaczu.
const favStore = store.get('mychat.favs', { list: [] });
const favList = () => (Array.isArray(favStore.list) ? favStore.list : []);
const isFav = (video) => favList().some((f) => f.src === video.src);
function toggleFav(video) {
  const list = favList();
  const at = list.findIndex((f) => f.src === video.src);
  if (at >= 0) list.splice(at, 1);
  else list.unshift({ href: video.href, src: video.src });
  favStore.list = list.slice(0, 50);
  store.set('mychat.favs', favStore);
  document.dispatchEvent(new CustomEvent('favs-changed'));
  return at < 0;
}
const favVideos = () => favList().map((f) => parseVideoLink(f.href)).filter(Boolean);

// Gwiazdka (przycisk) odświeżająca się, gdy ulubione zmienią się gdziekolwiek.
function bindFavButton(btn, getVideo) {
  const sync = () => {
    const on = isFav(getVideo());
    btn.classList.toggle('is-fav', on);
    btn.title = on ? 'Usuń z ulubionych' : 'Dodaj do ulubionych';
    btn.setAttribute('aria-pressed', String(on));
  };
  btn.addEventListener('click', () => {
    const added = toggleFav(getVideo());
    toast(added ? 'Dodano do ulubionych.' : 'Usunięto z ulubionych.', true);
  });
  document.addEventListener('favs-changed', () => btn.isConnected && sync());
  sync();
}

// ---------- Zapamiętane momenty ----------
// Znaczniki czasu w filmach (np. „12:30 – ten fragment”), do 20 na film. Odtwarzacze YouTube, Vimeo i pliki wideo
// potrafią wystartować od zapamiętanej sekundy; dla pozostałych zostaje podpowiedź, gdzie przewinąć.
function marksOf(video) {
  const all = favStore.marks || {};
  return Array.isArray(all[video.src]) ? all[video.src] : [];
}
function saveMarks(video, list) {
  const all = favStore.marks || {};
  all[video.src] = list.slice(0, 20);
  if (!all[video.src].length) delete all[video.src];
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete all[k]; // najstarsze wypadają
  favStore.marks = all;
  store.set('mychat.favs', favStore);
}
function parseClock(text) {
  const parts = String(text).trim().split(':').map((x) => Number(x));
  if (!parts.length || parts.length > 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return parts.reduce((total, n) => total * 60 + n, 0);
}
function formatClock(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = String(Math.floor(sec % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// ---------- Tryb dyskretny (opcjonalny) ----------
// Neutralny tytuł i ikona karty, klawisz H (albo zmiana karty przeglądarki) chowa multimedia i odtwarzacze.
const appTitle = (text) => (settings.discreet ? text.replace('MyChat', 'Notatki') : text);
const NEUTRAL_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='5' y='3' width='14' height='18' rx='2'/%3E%3Cpath d='M9 8h6M9 12h6M9 16h4'/%3E%3C/svg%3E";
function applyDiscreet() {
  document.title = appTitle(unread ? `(${unread}) MyChat` : 'MyChat');
  let link = document.querySelector('link[rel="icon"][data-discreet]');
  if (settings.discreet && !link) {
    link = document.createElement('link');
    link.rel = 'icon';
    link.dataset.discreet = '1';
    link.href = NEUTRAL_ICON;
    document.head.appendChild(link);
  } else if (!settings.discreet && link) {
    link.remove();
  }
  if (!settings.discreet) setMediaHidden(false);
}
function setMediaHidden(hidden) {
  document.body.classList.toggle('media-hidden', hidden);
  if (hidden) closeMiniPlayer();
  let pill = $('media-reveal');
  if (hidden && !pill) {
    pill = el('button', 'media-reveal', '· · ·');
    pill.id = 'media-reveal';
    pill.type = 'button';
    pill.title = 'Pokaż ukryte multimedia (H)';
    pill.addEventListener('click', () => setMediaHidden(false));
    document.body.appendChild(pill);
  } else if (!hidden && pill) {
    pill.remove();
  }
}
document.addEventListener('keydown', (e) => {
  if (!settings.discreet || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.toLowerCase() !== 'h' || e.target.closest('input, textarea, select, [contenteditable]')) return;
  setMediaHidden(!document.body.classList.contains('media-hidden'));
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && settings.discreet) setMediaHidden(true);
});
applyDiscreet();

// ---------- Tryb jednej ręki (telefon) ----------
// Lewa albo prawa ręka: przyciski w karcie wideo i w oknie odtwarzacza przechodzą do dolnego rzędu, po stronie kciuka.
// Reszta aplikacji wygląda tak samo. Działa tylko na wąskich ekranach.
const narrowScreen = window.matchMedia('(max-width: 720px)');
const oneHandActive = () => settings.oneHand !== 'off' && narrowScreen.matches;

function applyOneHand() {
  document.body.classList.toggle('onehand', settings.oneHand !== 'off');
  document.body.classList.toggle('onehand--left', settings.oneHand === 'left');
  document.body.classList.toggle('onehand--right', settings.oneHand === 'right');
}
narrowScreen.addEventListener('change', () => miniPlayer && miniPlayer._applyLayout?.());
applyOneHand();

// ---------- Oglądajmy razem ----------
// Serwer pilnuje stanu: publiczne zaproszenie dla kanału albo prywatny seans dla dwóch osób, lista uczestników,
// kolejka z głosowaniem, odliczanie 3-2-1 i reakcje na żywo. Klient dostaje „swój” widok seansu na kanale.
const partyByChannel = new Map(); // kanał -> widok seansu z serwera albo null
const currentParty = () => partyByChannel.get(currentChannel) || null;
const iAmViewer = (p = currentParty()) => Boolean(p && myAccountId && p.viewers.some((v) => v.id === myAccountId));
const inPartyPlayer = () => Boolean(miniPlayer && miniPlayer.classList.contains('miniplayer--party'));
const DEFAULT_REACTIONS = ['🔥', '😍', '👏', '😂', '❤️', '😮'];

// Własne reakcje z ustawień (do 8 emotek, rozdzielane na „znaki” użytkownika, nie na bajty).
function reactionSet() {
  const raw = String(settings.partyEmoji || '');
  const graphemes = window.Intl && Intl.Segmenter ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(raw), (x) => x.segment) : Array.from(raw);
  const list = graphemes.filter((g) => /\p{Extended_Pictographic}/u.test(g)).slice(0, 8);
  return list.length ? list : DEFAULT_REACTIONS;
}

// Krótkie dźwięki seansu (tik odliczania, start, reakcja) – tylko gdy włączone w ustawieniach.
function partyTone(kind) {
  if (!settings.partySounds) return;
  try {
    const ctx = getAudioCtx();
    const t = ctx.currentTime;
    const [freq, len, vol] = kind === 'tick' ? [520, 0.09, 0.08] : kind === 'go' ? [880, 0.35, 0.12] : [740, 0.07, 0.04];
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + len);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + len + 0.02);
  } catch {
    /* brak audio – pomijamy */
  }
}

// Spokojne tło dźwiękowe do trybu kinowego: dwie nastrojone sinusoidy z wolnym falowaniem głośności.
let ambientPad = null;
function toggleAmbientPad(on) {
  if (!on) {
    if (ambientPad) {
      const { gain, nodes, ctx } = ambientPad;
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
      setTimeout(() => nodes.forEach((n) => n.stop()), 700);
      ambientPad = null;
    }
    return;
  }
  if (ambientPad) return;
  try {
    const ctx = getAudioCtx();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 2);
    gain.connect(ctx.destination);
    const nodes = [110, 164.8, 220.5].map((freq, i) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      g.gain.value = 0.35 - i * 0.08;
      osc.connect(g).connect(gain);
      osc.start();
      return osc;
    });
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.12;
    lfoGain.gain.value = 0.02;
    lfo.connect(lfoGain).connect(gain.gain);
    lfo.start();
    nodes.push(lfo);
    ambientPad = { ctx, gain, nodes };
  } catch {
    /* brak audio – pomijamy */
  }
}

// Ekran nie gaśnie, gdy gra film (Wake Lock API – działa w nowych przeglądarkach).
let wakeLock = null;
async function holdScreenAwake(on) {
  try {
    if (!on) {
      await wakeLock?.release();
      wakeLock = null;
    } else if (navigator.wakeLock && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    }
  } catch {
    /* przeglądarka odmówiła – nic się nie dzieje */
  }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && miniPlayer && settings.keepAwake) holdScreenAwake(true);
});

// Seans z czatem głosowym: dołączamy do kanału głosowego grupy i wyciszamy dźwięki aplikacji, żeby nie przeszkadzały.
let autoVoice = false;
function partyVoiceOn() {
  if (!settings.partyVoice) return;
  appSoundsMuted = true;
  if (!voice.active && !voice.joining && myCurrentGroup()) {
    autoVoice = true;
    joinVoice();
  }
}
function partyVoiceOff() {
  appSoundsMuted = false;
  if (autoVoice) {
    autoVoice = false;
    leaveVoice();
  }
}

function startParty(video, { invite } = {}) {
  socket.emit('party:start', { href: video.href, invite }, (res) => {
    if (!res || !res.ok) return toast((res && res.error) || 'Nie udało się zaprosić do oglądania.');
    openMiniPlayer(video, { party: true });
  });
}

// Wybór, kto ma oglądać: cały kanał albo jedna osoba (prywatny seans dla dwóch).
function openPartyChooser(anchor, video) {
  document.querySelector('.partychooser')?.remove();
  const others = onlineUsers.filter((u) => u.id !== myAccountId);
  if (!others.length) return startParty(video);
  const box = el('div', 'partychooser');
  const add = (label, hint, onClick) => {
    const b = el('button', 'partychooser__item');
    b.type = 'button';
    b.append(el('span', '', label), el('small', '', hint));
    b.addEventListener('click', () => {
      box.remove();
      onClick();
    });
    box.appendChild(b);
  };
  add('Cały kanał', 'Zaproszenie widzą wszyscy', () => startParty(video));
  others.slice(0, 12).forEach((u) => add(`Tylko ${u.nick}`, 'Prywatny seans dla dwóch osób', () => startParty(video, { invite: u.id })));
  document.body.appendChild(box);
  const r = anchor.getBoundingClientRect();
  box.style.top = `${Math.min(r.bottom + 6, window.innerHeight - box.offsetHeight - 8)}px`;
  box.style.left = `${Math.max(8, Math.min(r.right - box.offsetWidth, window.innerWidth - box.offsetWidth - 8))}px`;
  const away = (e) => {
    if (box.contains(e.target)) return;
    box.remove();
    document.removeEventListener('pointerdown', away, true);
  };
  setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
}

function joinParty(id) {
  socket.emit('party:join', { id }, (res) => {
    if (!res || !res.ok) return toast((res && res.error) || 'Nie udało się dołączyć.');
    const video = parseVideoLink(res.party.href);
    if (video) openMiniPlayer(video, { party: true, immediate: res.party.started });
  });
}

function leaveParty() {
  socket.emit('party:leave');
  if (inPartyPlayer()) closeMiniPlayer();
}

// Podsumowanie po seansie: najgorętsze momenty według liczby reakcji.
function showPartyStats() {
  socket.emit('party:stats', {}, (res) => {
    if (!res || !res.ok) return toast('Brak danych do podsumowania.');
    document.querySelector('.partystats')?.remove();
    const card = el('div', 'partystats');
    card.appendChild(el('h3', '', 'Podsumowanie seansu'));
    if (!res.total) card.appendChild(el('p', '', 'Nikt jeszcze nie zareagował – po starcie filmu pojawią się tu najgorętsze momenty.'));
    else {
      card.appendChild(el('p', '', `Reakcji łącznie: ${res.total}`));
      const list = el('ol', 'partystats__top');
      for (const t of res.top) list.appendChild(el('li', '', `${formatClock(t.fromSec)}–${formatClock(t.toSec)} od startu · ${t.emoji} ${t.count}`));
      card.append(el('div', 'partystats__label', 'Najgorętsze momenty'), list);
      const totals = Object.entries(res.totals).sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e} ${n}`).join('   ');
      card.appendChild(el('p', 'partystats__totals', totals));
    }
    card.appendChild(iconButton('close', 'Zamknij', () => card.remove()));
    document.body.appendChild(card);
  });
}

// Szkic pola „dodaj do kolejki” przetrwa odświeżenie paska (po każdej zmianie stanu serwer wysyła nowy widok).
let queueOpen = false;
let queueDraft = '';

function renderPartyBar() {
  const bar = $('party-bar');
  const p = currentParty();
  if (!p) {
    bar.classList.add('hidden');
    return bar.replaceChildren();
  }
  const refocus = document.activeElement && document.activeElement.classList.contains('partybar__add') && bar.contains(document.activeElement);
  const video = parseVideoLink(p.href);
  const viewer = iAmViewer(p);
  const isHost = p.hostId === myAccountId;

  const info = el('div', 'partybar__info');
  const host = el('b', '', p.host);
  const label = video ? ` · ${video.label}` : '';
  if (p.private && viewer) info.textContent = `Prywatny seans${label}`;
  else info.append(host, document.createTextNode(p.private ? ` zaprasza Cię na prywatny seans${label}` : ` zaprasza do wspólnego oglądania${label}`));
  info.appendChild(el('div', 'partybar__who', `Oglądają (${p.viewers.length}): ${p.viewers.map((v) => v.nick).join(', ')}`));

  const buttons = el('div', 'partybar__actions');
  const mk = (cls, name, label, onClick, text = '') => {
    const b = iconNode('button', `${cls} btn-iconly`, name, text);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  };
  if (!viewer) {
    if (video) buttons.appendChild(mk('btn-primary btn-sm', 'login', 'Dołącz do seansu', () => joinParty(p.id)));
  } else {
    if (video && !inPartyPlayer()) {
      buttons.appendChild(mk('btn-secondary btn-sm', 'popout', 'Otwórz odtwarzacz', () => openMiniPlayer(video, { party: true, immediate: p.started })));
    }
    if (isHost) buttons.appendChild(mk('btn-primary btn-sm', 'play', 'Start – odliczanie 3·2·1 dla wszystkich', () => socket.emit('party:go'), '3·2·1'));
    if (p.started) buttons.appendChild(mk('btn-secondary btn-sm', 'chart', 'Podsumowanie seansu', showPartyStats));
    buttons.appendChild(mk('btn-secondary btn-sm', 'logout', 'Wyjdź z seansu', leaveParty));
  }
  const top = el('div', 'partybar__top');
  top.append(iconNode('span', 'partybar__icon', p.private ? 'user' : 'users'), info, buttons);
  bar.replaceChildren(top);

  if (viewer) {
    // Kolejka: dokładasz linki, głosujesz, a gospodarz włącza zwycięzcę.
    const q = el('details', 'partybar__queue');
    q.open = queueOpen;
    q.addEventListener('toggle', () => {
      queueOpen = q.open;
    });
    q.appendChild(el('summary', '', `Kolejka (${p.queue.length}) – co oglądamy dalej`));
    const list = el('div', 'partybar__qlist');
    const ranked = p.queue.map((item, i) => ({ item, i })).sort((a, b) => b.item.voters.length - a.item.voters.length || a.i - b.i);
    for (const { item } of ranked) {
      const v = parseVideoLink(item.href);
      const row = el('div', 'partybar__qrow');
      const voted = item.voters.includes(myAccountId);
      const vote = iconNode('button', `partybar__vote${voted ? ' is-voted' : ''}`, 'chevron-up', String(item.voters.length));
      vote.type = 'button';
      vote.title = voted ? 'Cofnij głos' : 'Zagłosuj na ten film';
      vote.addEventListener('click', () => socket.emit('party:queue:vote', item.id));
      const label = el('span', 'partybar__qtext', `${v ? v.label : 'Link'} · dodał(a) ${item.by}`);
      label.title = item.href;
      row.append(vote, label);
      if (isHost || item.by === p.viewers.find((x) => x.id === myAccountId)?.nick) {
        const del = iconNode('button', 'partybar__qdel', 'close');
        del.type = 'button';
        del.title = 'Usuń z kolejki';
        del.addEventListener('click', () => socket.emit('party:queue:remove', item.id));
        row.appendChild(del);
      }
      list.appendChild(row);
    }
    if (!p.queue.length) list.appendChild(el('div', 'partybar__qempty', 'Kolejka jest pusta – dodaj link poniżej.'));
    const form = el('form', 'partybar__qform');
    const input = el('input', 'partybar__add');
    input.type = 'url';
    input.placeholder = 'Wklej link do filmu…';
    input.value = queueDraft;
    input.addEventListener('input', () => {
      queueDraft = input.value;
    });
    const addBtn = iconNode('button', 'btn-secondary btn-sm btn-iconly', 'plus');
    addBtn.type = 'submit';
    addBtn.title = 'Dodaj do kolejki';
    addBtn.setAttribute('aria-label', addBtn.title);
    form.append(input, addBtn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const href = input.value.trim();
      if (!href) return;
      if (!parseVideoLink(href)) return toast('Ten link nie jest obsługiwanym filmem.');
      socket.emit('party:queue:add', { href }, (res) => {
        if (!res || !res.ok) return toast((res && res.error) || 'Nie udało się dodać.');
        queueDraft = '';
        input.value = '';
      });
    });
    q.append(list, form);
    if (isHost) {
      const next = mk('btn-primary btn-sm', 'skip-next', 'Następny film (wygrywa najwięcej głosów)', () =>
        socket.emit('party:next', {}, (res) => res && !res.ok && toast(res.error))
      );
      next.disabled = !p.queue.length;
      q.appendChild(next);
    }
    bar.appendChild(q);
  }
  bar.classList.remove('hidden');
  if (refocus) bar.querySelector('.partybar__add')?.focus();
}

socket.on('party:update', ({ channel, party: p }) => {
  const before = partyByChannel.get(channel);
  partyByChannel.set(channel, p || null);
  if (p && p.private && (!before || before.id !== p.id) && !iAmViewer(p)) {
    toast(`${p.host} zaprasza Cię na prywatny seans.`, true);
    beep([660, 990]);
  }
  if (inPartyPlayer() && miniPlayer._partyChannel === channel && !iAmViewer(p)) closeMiniPlayer();
  if (channel === currentChannel) renderPartyBar();
  if (miniPlayer && miniPlayer._refreshParty) miniPlayer._refreshParty();
});
socket.on('party:countdown', ({ channel, id, inMs }) => {
  const p = partyByChannel.get(channel);
  if (!p || p.id !== id || !iAmViewer(p) || !inPartyPlayer() || miniPlayer._partyChannel !== channel) return;
  miniPlayer._partyCountdown(inMs);
});
socket.on('party:react', ({ channel, nick, emoji }) => {
  if (inPartyPlayer() && miniPlayer._partyChannel === channel) {
    miniPlayer._burst(emoji, nick);
    partyTone('react');
  }
});

// Pływający odtwarzacz: jedno okno na całą aplikację. Przeciągasz je za pasek – po puszczeniu przyciąga się do
// najbliższego rogu. Ma trzy rozmiary, tryb kinowy (duży, na środku, z czatem na tle filmu, poświatą, ściemnianiem
// i tłem dźwiękowym), listę odtwarzania (filmy z kanału albo ulubione), zapamiętane momenty, skróty klawiszowe
// i tryb „razem” (wspólny start, reakcje na żywo). Rozmiar, róg i poziom ściemnienia są pamiętane na urządzeniu.
let miniPlayer = null;
const playerPrefs = store.get('mychat.player', { size: 'm', corner: 'br', dim: 82 });
const PLAYER_SIZES = ['s', 'm', 'l'];
const savePlayerPrefs = () => store.set('mychat.player', playerPrefs);

function closeMiniPlayer() {
  if (!miniPlayer) return;
  const wasParty = miniPlayer.classList.contains('miniplayer--party');
  clearInterval(miniPlayer._countTimer);
  clearInterval(miniPlayer._glowTimer);
  miniPlayer._backdrop?.remove();
  miniPlayer.remove(); // usunięcie iframe/video zatrzymuje dźwięk
  miniPlayer = null;
  toggleAmbientPad(false);
  holdScreenAwake(false);
  if (wasParty) partyVoiceOff();
}

// Wszystkie różne filmy z linków w wiadomościach widocznych na kanale, w kolejności rozmowy.
function channelVideos() {
  const seen = new Set();
  const list = [];
  messagesEl.querySelectorAll('.msg__text[data-raw]').forEach((node) => {
    for (const v of videosInText(node.dataset.raw)) {
      if (seen.has(v.src)) continue;
      seen.add(v.src);
      list.push(v);
    }
  });
  return list;
}

// Czat na tle filmu w trybie kinowym: ostatnie wiadomości znikają po chwili.
function pushCinemaFeed(nick, text) {
  const feed = miniPlayer && miniPlayer.classList.contains('miniplayer--cinema') && miniPlayer._feed;
  if (!feed) return;
  const line = el('div', 'miniplayer__feedline');
  line.append(el('b', '', nick), document.createTextNode(` ${String(text).slice(0, 140)}`));
  feed.appendChild(line);
  while (feed.children.length > 4) feed.firstChild.remove();
  setTimeout(() => line.remove(), 9000);
}

function openMiniPlayer(video, opts = {}) {
  closeMiniPlayer();
  setMediaHidden(false);
  const partyMode = Boolean(opts.party);
  let mode = 'channel'; // źródło listy: 'channel' albo 'favs'
  let list = channelVideos();
  let index = list.findIndex((v) => v.src === video.src);
  if (partyMode || index < 0) {
    list = [video];
    index = 0;
  }
  let live = !partyMode || Boolean(opts.immediate); // w trybie „razem” film startuje dopiero po odliczaniu
  let startSec = 0; // od której sekundy startuje film (z zapamiętanego momentu)

  const box = el('div', 'miniplayer');
  box.dataset.glow = settings.partyGlow;
  if (partyMode) {
    box.classList.add('miniplayer--party');
    box._partyChannel = currentChannel;
    partyVoiceOn();
  }
  const applyLayout = () => {
    if (!PLAYER_SIZES.includes(playerPrefs.size)) playerPrefs.size = 'm';
    if (!/^(t|b)(l|r)$/.test(playerPrefs.corner)) playerPrefs.corner = 'br';
    box.classList.remove('miniplayer--s', 'miniplayer--m', 'miniplayer--l');
    box.classList.add(`miniplayer--${playerPrefs.size}`);
    for (const c of ['tl', 'tr', 'bl', 'br']) box.classList.toggle(`miniplayer--${c}`, c === playerPrefs.corner);
    box.classList.toggle('miniplayer--onehand', oneHandActive()); // przyciski na dole, okno przy kciuku
  };
  applyLayout();
  box._applyLayout = applyLayout;

  const bar = el('div', 'miniplayer__bar');
  const title = iconNode('span', 'miniplayer__title', 'play', '');
  const titleText = title.appendChild(document.createTextNode(''));
  const mkBtn = (icon, tip, onClick) => {
    const b = iconNode('button', 'miniplayer__btn', icon);
    b.type = 'button';
    b.title = tip;
    b.setAttribute('aria-label', tip);
    b.addEventListener('click', onClick);
    return b;
  };
  const prev = mkBtn('skip-back', 'Poprzedni film (P)', () => go(-1));
  const next = mkBtn('skip-next', 'Następny film (N)', () => go(1));
  const source = mkBtn('list', 'Lista: filmy z kanału / ulubione', () => switchSource());
  const fav = mkBtn('star', 'Dodaj do ulubionych (F)', () => {});
  bindFavButton(fav, () => list[index]);
  const marksBtn = mkBtn('bookmark', 'Zapamiętane momenty (M)', () => toggleMarks());
  const size = mkBtn('size', 'Zmień rozmiar okna', () => {
    playerPrefs.size = PLAYER_SIZES[(PLAYER_SIZES.indexOf(playerPrefs.size) + 1) % PLAYER_SIZES.length];
    savePlayerPrefs();
    applyLayout();
  });
  const cinema = mkBtn('cinema', 'Tryb kinowy (C, Esc – wyjście)', () => setCinema(!box.classList.contains('miniplayer--cinema')));
  const collapse = mkBtn('minus', 'Zwiń / rozwiń', () => box.classList.toggle('miniplayer--collapsed'));
  const close = mkBtn('close', 'Zamknij odtwarzacz', closeMiniPlayer);
  if (partyMode) prev.hidden = next.hidden = source.hidden = true;
  const btns = el('div', 'miniplayer__btns');
  btns.append(prev, next, source, fav, marksBtn, size, cinema, collapse, close);
  bar.append(title, btns);

  const body = el('div', 'miniplayer__body');
  const feed = el('div', 'miniplayer__feed');
  const marksPanel = el('div', 'miniplayer__marks hidden');
  box._feed = feed;
  box.append(bar, body);

  // Pasek narzędzi trybu kinowego: ściemnianie, tło dźwiękowe i pole „napisz do czatu”.
  const tools = el('div', 'miniplayer__tools');
  const dim = el('input', 'miniplayer__dim');
  dim.type = 'range';
  dim.min = '20';
  dim.max = '100';
  dim.value = String(playerPrefs.dim ?? 82);
  dim.title = 'Jak ciemno wokół filmu';
  dim.setAttribute('aria-label', 'Jak ciemno wokół filmu');
  dim.addEventListener('input', () => {
    playerPrefs.dim = Number(dim.value);
    savePlayerPrefs();
    if (box._backdrop) box._backdrop.style.background = `rgba(0, 0, 0, ${playerPrefs.dim / 100})`;
  });
  const music = mkBtn('music', 'Spokojne tło dźwiękowe', () => {
    const on = !music.classList.contains('is-on');
    music.classList.toggle('is-on', on);
    toggleAmbientPad(on);
  });
  const say = el('form', 'miniplayer__say');
  const sayInput = el('input');
  sayInput.type = 'text';
  sayInput.maxLength = 500;
  sayInput.placeholder = 'Napisz do czatu…';
  sayInput.autocomplete = 'off';
  say.appendChild(sayInput);
  say.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = sayInput.value.trim();
    if (!text) return;
    socket.emit('message', { text });
    sayInput.value = '';
  });
  tools.append(dim, music, say);
  box.appendChild(tools);

  if (partyMode) {
    const reactions = el('div', 'miniplayer__reactions');
    for (const emoji of reactionSet()) {
      const b = el('button', '', emoji);
      b.type = 'button';
      b.title = 'Wyślij reakcję do oglądających';
      b.addEventListener('click', () => socket.emit('party:react', emoji));
      reactions.appendChild(b);
    }
    box.appendChild(reactions);
  }

  function updateTitle() {
    const v = list[index];
    let text = v.label;
    if (partyMode) {
      const p = partyByChannel.get(box._partyChannel);
      text += p ? ` · ${p.private ? 'prywatnie' : 'razem'} (${p.viewers.length})` : '';
    } else if (list.length > 1) {
      text += ` · ${mode === 'favs' ? '★ ' : ''}${index + 1}/${list.length}`;
    }
    titleText.textContent = text;
  }

  function waitPanel() {
    const w = el('div', 'miniplayer__wait');
    const p = partyByChannel.get(box._partyChannel);
    w.append(iconNode('span', 'miniplayer__waiticon', 'hourglass'), document.createTextNode(`Czekamy na start${p ? ` od ${p.host}` : ''}…`));
    return w;
  }

  // Poświata według obrazu: dla plików wideo (gdy serwer pozwala odczytać piksele) próbkujemy średni kolor.
  function startGlowSampling() {
    clearInterval(box._glowTimer);
    box.style.removeProperty('--glow');
    if (settings.partyGlow !== 'image' || list[index].kind !== 'video') return;
    const v = body.querySelector('video');
    if (!v) return;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    const ctx2d = canvas.getContext('2d', { willReadFrequently: true });
    box._glowTimer = setInterval(() => {
      if (v.paused || v.readyState < 2) return;
      try {
        ctx2d.drawImage(v, 0, 0, 8, 8);
        const d = ctx2d.getImageData(0, 0, 8, 8).data;
        let r = 0, g = 0, bl = 0;
        for (let i = 0; i < d.length; i += 4) {
          r += d[i];
          g += d[i + 1];
          bl += d[i + 2];
        }
        const n = d.length / 4;
        box.style.setProperty('--glow', `rgba(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(bl / n)}, 0.55)`);
      } catch {
        clearInterval(box._glowTimer); // wideo bez CORS – zostaje poświata w kolorze serwisu
      }
    }, 400);
  }

  function show() {
    const v = list[index];
    box.dataset.provider = v.provider;
    marksPanel.classList.add('hidden');
    const node = live ? makePlayerNode(v, 'miniplayer__media', { startSec, ambient: settings.partyGlow === 'image' }) : waitPanel();
    body.replaceChildren(node, feed, marksPanel);
    box.classList.toggle('miniplayer--short', Boolean(v.short)); // krótkie filmy: okno w układzie pionowym
    startSec = 0;
    updateTitle();
    prev.disabled = index === 0;
    next.disabled = index === list.length - 1;
    if (!partyMode) prev.hidden = next.hidden = list.length < 2 && mode === 'channel';
    box.classList.toggle('miniplayer--waiting', !live);
    startGlowSampling();
  }
  function go(step) {
    const target = index + step;
    if (partyMode || target < 0 || target >= list.length) return;
    index = target;
    box.classList.remove('miniplayer--collapsed');
    show();
  }
  function switchSource() {
    if (partyMode) return;
    if (mode === 'channel') {
      const favs = favVideos();
      if (!favs.length) return toast('Nie masz jeszcze ulubionych – dodaj film gwiazdką.', true);
      const current = list[index];
      mode = 'favs';
      list = favs;
      index = Math.max(0, favs.findIndex((v) => v.src === current.src));
    } else {
      mode = 'channel';
      const current = list[index];
      list = channelVideos();
      index = list.findIndex((v) => v.src === current.src);
      if (index < 0) {
        list = [current, ...list];
        index = 0;
      }
    }
    toast(mode === 'favs' ? 'Lista: ulubione.' : 'Lista: filmy z kanału.', true);
    show();
  }

  // Zapamiętane momenty: lista z możliwością skoku i dodania nowego (dla plików wideo czas bierzemy z odtwarzacza).
  function renderMarks() {
    const v = list[index];
    const marks = marksOf(v);
    marksPanel.replaceChildren(el('div', 'miniplayer__markshead', 'Zapamiętane momenty'));
    if (!marks.length) marksPanel.appendChild(el('div', 'miniplayer__marksempty', 'Brak – dodaj pierwszy, gdy trafisz na ulubiony fragment.'));
    marks.forEach((m, i) => {
      const row = el('div', 'miniplayer__markrow');
      const jump = el('button', 'miniplayer__markjump', `${formatClock(m.sec)}${m.label ? ` · ${m.label}` : ''}`);
      jump.type = 'button';
      jump.addEventListener('click', () => {
        live = true;
        startSec = m.sec;
        show();
      });
      const del = iconNode('button', 'miniplayer__markdel', 'close');
      del.type = 'button';
      del.title = 'Usuń moment';
      del.addEventListener('click', () => {
        marks.splice(i, 1);
        saveMarks(v, marks);
        renderMarks();
      });
      row.append(jump, del);
      marksPanel.appendChild(row);
    });
    const add = iconNode('button', 'btn-secondary btn-sm btn-iconly', 'plus');
    add.type = 'button';
    add.title = 'Zapamiętaj moment';
    add.setAttribute('aria-label', add.title);
    add.addEventListener('click', () => {
      const media = body.querySelector('video');
      const guess = media && Number.isFinite(media.currentTime) ? formatClock(media.currentTime) : '';
      const raw = prompt('Czas w filmie (np. 12:30 albo 1:02:03):', guess);
      if (raw === null) return;
      const sec = parseClock(raw);
      if (sec === null) return toast('Nie rozumiem tego czasu – wpisz np. 12:30.');
      const label = (prompt('Opis (opcjonalnie):', '') || '').trim().slice(0, 40);
      const next2 = [{ sec, label }, ...marks.filter((m) => m.sec !== sec)].sort((a, b) => a.sec - b.sec);
      saveMarks(v, next2);
      renderMarks();
    });
    marksPanel.appendChild(add);
  }
  function toggleMarks() {
    if (marksPanel.classList.contains('hidden')) {
      renderMarks();
      marksPanel.classList.remove('hidden');
    } else marksPanel.classList.add('hidden');
  }

  function setCinema(on) {
    box.classList.toggle('miniplayer--cinema', on);
    if (on && !box._backdrop) {
      box._backdrop = el('div', 'miniplayer-backdrop');
      box._backdrop.style.background = `rgba(0, 0, 0, ${(playerPrefs.dim ?? 82) / 100})`;
      box._backdrop.addEventListener('click', () => setCinema(false));
      document.body.insertBefore(box._backdrop, box);
    } else if (!on && box._backdrop) {
      box._backdrop.remove();
      box._backdrop = null;
    }
    if (!on) {
      feed.replaceChildren();
      music.classList.remove('is-on');
      toggleAmbientPad(false);
    }
    box.classList.remove('miniplayer--collapsed');
  }
  box._exitCinema = () => {
    if (!box.classList.contains('miniplayer--cinema')) return false;
    setCinema(false);
    return true;
  };
  // Dla skrótów klawiszowych.
  box._api = { go, cinema: () => setCinema(!box.classList.contains('miniplayer--cinema')), fav: () => fav.click(), marks: toggleMarks };

  // Tryb „razem”: odliczanie 3-2-1 nad czekającym odtwarzaczem, potem start u wszystkich naraz.
  box._partyCountdown = (ms) => {
    clearInterval(box._countTimer);
    live = false;
    show();
    box.classList.remove('miniplayer--collapsed');
    const count = el('div', 'miniplayer__count');
    body.appendChild(count);
    const endAt = Date.now() + ms;
    const tick = () => {
      const left = endAt - Date.now();
      if (left <= 0) {
        clearInterval(box._countTimer);
        live = true;
        show();
        partyTone('go');
        return;
      }
      const n = String(Math.ceil(left / 1000));
      if (count.textContent !== n) {
        count.textContent = n;
        count.classList.remove('pop');
        void count.offsetWidth; // restart animacji
        count.classList.add('pop');
        partyTone('tick');
      }
    };
    box._countTimer = setInterval(tick, 100);
    tick();
  };
  box._refreshParty = () => {
    const p = partyByChannel.get(box._partyChannel);
    const parsed = p && parseVideoLink(p.href);
    if (parsed && parsed.src !== list[index].src) {
      list = [parsed]; // gospodarz włączył następny film z kolejki
      index = 0;
      live = false;
      show();
      return;
    }
    updateTitle();
    if (!live && !box.querySelector('.miniplayer__count')) body.replaceChildren(waitPanel(), feed, marksPanel);
  };
  // Reakcje na żywo unoszą się nad filmem.
  box._burst = (emoji, nick) => {
    const b = el('div', 'party-burst');
    b.append(el('span', 'party-burst__emoji', emoji), el('span', 'party-burst__nick', nick));
    b.style.left = `${8 + Math.random() * 70}%`;
    b.addEventListener('animationend', () => b.remove());
    body.appendChild(b);
  };

  show();
  document.body.appendChild(box);
  miniPlayer = box;
  if (settings.keepAwake) holdScreenAwake(true);
  if (partyMode) renderPartyBar();

  // Przeciąganie za pasek tytułu (mysz i dotyk); po puszczeniu okno przyciąga się do najbliższego rogu.
  // W trybie kinowym pasek obsługuje przesunięcie palcem w bok: następny / poprzedni film.
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    if (box.classList.contains('miniplayer--cinema')) {
      const startX = e.clientX;
      const done = (ev) => {
        bar.removeEventListener('pointerup', done);
        const dx = ev.clientX - startX;
        if (Math.abs(dx) > 60) go(dx < 0 ? 1 : -1);
      };
      bar.addEventListener('pointerup', done);
      return;
    }
    const rect = box.getBoundingClientRect();
    const dx = e.clientX - rect.left;
    const dy = e.clientY - rect.top;
    bar.setPointerCapture(e.pointerId);
    box.classList.add('miniplayer--dragging'); // na czas ruchu iframe nie może przechwytywać kursora
    const move = (ev) => {
      const x = Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - box.offsetWidth);
      const y = Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - box.offsetHeight);
      box.style.left = `${x}px`;
      box.style.top = `${y}px`;
      box.style.right = 'auto';
      box.style.bottom = 'auto';
    };
    const stop = () => {
      const r = box.getBoundingClientRect();
      const vertical = r.top + r.height / 2 < window.innerHeight / 2 ? 't' : 'b';
      const horizontal = r.left + r.width / 2 < window.innerWidth / 2 ? 'l' : 'r';
      playerPrefs.corner = vertical + horizontal;
      savePlayerPrefs();
      box.style.left = box.style.top = box.style.right = box.style.bottom = '';
      applyLayout();
      box.classList.remove('miniplayer--dragging');
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', stop);
      bar.removeEventListener('pointercancel', stop);
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', stop);
    bar.addEventListener('pointercancel', stop);
  });
}

// Esc wychodzi z trybu kinowego; N / P / C / F / M sterują odtwarzaczem, gdy nie piszesz w żadnym polu.
document.addEventListener('keydown', (e) => {
  if (!miniPlayer) return;
  if (e.key === 'Escape' && miniPlayer._exitCinema()) return e.stopPropagation();
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea, select, [contenteditable]')) return;
  const api = miniPlayer._api;
  const key = e.key.toLowerCase();
  if (key === 'n') api.go(1);
  else if (key === 'p') api.go(-1);
  else if (key === 'c') api.cinema();
  else if (key === 'f') api.fav();
  else if (key === 'm') api.marks();
});

// Pierwsze 2 różne linki do wideo z tekstu wiadomości.
function videosInText(text) {
  const seen = new Set();
  const found = [];
  for (const [url] of String(text).matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const video = parseVideoLink(url);
    if (!video || seen.has(video.src)) continue;
    seen.add(video.src);
    found.push(video);
    if (found.length === 2) break;
  }
  return found;
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

// ---------- Ulubione GIFy ----------
// Gwiazdka w prawym górnym rogu GIFa (w czacie i w wynikach wyszukiwania) zapisuje go na liście na tym urządzeniu (do 100).
// Lista pokazuje się w panelu GIF, w zakładce „Ulubione”, jako małe podglądy – kliknięcie wysyła GIF.
const gifFavStore = store.get('mychat.gifs', { list: [] });
const gifFavs = () => (Array.isArray(gifFavStore.list) ? gifFavStore.list : []);
const isGifFav = (url) => gifFavs().includes(url);
function toggleGifFav(url) {
  const list = gifFavs();
  const at = list.indexOf(url);
  if (at >= 0) list.splice(at, 1);
  else list.unshift(url);
  gifFavStore.list = list.slice(0, 100);
  store.set('mychat.gifs', gifFavStore);
  document.dispatchEvent(new CustomEvent('gifs-changed'));
  return at < 0;
}

// Przycisk gwiazdki, który sam pilnuje swojego stanu, gdy ulubione zmienią się gdziekolwiek.
function makeGifFavButton(url) {
  const btn = iconNode('button', 'giffav', 'star');
  btn.type = 'button';
  const sync = () => {
    const on = isGifFav(url);
    btn.classList.toggle('is-fav', on);
    btn.title = on ? 'Usuń GIFa z ulubionych' : 'Dodaj GIFa do ulubionych';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', String(on));
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation(); // nie otwieraj podglądu ani nie wysyłaj GIFa z panelu
    toggleGifFav(url);
  });
  document.addEventListener('gifs-changed', () => btn.isConnected && sync());
  sync();
  return btn;
}

// GIF w wiadomości: obraz z gwiazdką w prawym górnym rogu.
function makeGifBox(url, onLoad) {
  const box = el('div', 'gifmsg');
  box.append(makeImage(url, onLoad), makeGifFavButton(url));
  return box;
}

function fileIcon(mime, name) {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'music';
  if (mime.startsWith('video/')) return 'film';
  if (mime === 'application/pdf') return 'file';
  if (/\.(zip|rar|7z|tar|gz)$/i.test(name)) return 'archive';
  if (mime.startsWith('text/')) return 'file-text';
  return 'paperclip';
}

function fileIconBox(mime, name) {
  return iconNode('div', 'filecard__icon', fileIcon(mime, name));
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
  getMessage: (id) => reqP(archive.db.transaction('messages').objectStore('messages').get(id)),
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

  // Wyjście z grupy lub jej usunięcie: wiadomości i pliki tej grupy znikają też z archiwum na tym urządzeniu.
  async removeChannel(channel) {
    if (!this.ready) return;
    const tx = this.db.transaction(['messages', 'files'], 'readwrite');
    const files = tx.objectStore('files');
    const range = IDBKeyRange.bound([channel, 0], [channel, Number.MAX_SAFE_INTEGER]);
    const cursor = tx.objectStore('messages').index('channel_time').openCursor(range);
    cursor.onsuccess = () => {
      const cur = cursor.result;
      if (!cur) return;
      files.delete(cur.value.id);
      cur.delete();
      cur.continue();
    };
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
            const kv = this.db.transaction('kv').objectStore('kv');
            this.data = (await reqP(kv.get('backup'))) || null;
            this.emoji = (await reqP(this.db.transaction('kv').objectStore('kv').get('emoji'))) || [];
          } catch {
            this.data = null;
            this.emoji = [];
          }
          resolve();
        };
        req.onerror = () => resolve();
      } catch {
        resolve(); // np. tryb prywatny – czat działa dalej bez kopii
      }
    });
  },

  emoji: [], // własne emoji tej osoby: [{ name, image: data-URL }] – żeby dało się je odtworzyć po zresetowaniu serwera

  async saveEmojiList() {
    if (!this.db) return;
    try {
      const tx = this.db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(this.emoji, 'emoji');
      await txDone(tx);
    } catch (err) {
      handleArchiveError(err);
    }
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

// Własne emoji: kopia lokalna uzupełnia się o emoji, które masz na serwerze, a gdy serwer straci dane,
// Twoje emoji wracają same (każdy odtwarza swoje, więc wystarczy, że po aktualizacji wejdziesz na czat).
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let emojiRestoring = false;

async function backupOwnEmoji() {
  await backup.ready;
  let changed = false;
  for (const e of customEmoji.filter((x) => x.byId && x.byId === myAccountId)) {
    if (backup.emoji.some((x) => x.name.toLowerCase() === e.name.toLowerCase())) continue;
    try {
      backup.emoji.push({ name: e.name, image: await urlToDataUrl(e.url) });
      changed = true;
    } catch {
      /* spróbujemy przy następnym logowaniu */
    }
  }
  if (changed) await backup.saveEmojiList();
}

async function restoreMissingEmoji() {
  await backup.ready;
  if (emojiRestoring || !backup.emoji.length) return;
  emojiRestoring = true;
  let restored = 0;
  try {
    for (const item of [...backup.emoji]) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (emojiByName.has(item.name.toLowerCase())) break; // już jest na serwerze
        const res = await new Promise((resolve) =>
          socket.timeout(20000).emit('emoji:add', { name: item.name, image: item.image }, (err, r) => resolve(err ? { ok: false } : r))
        );
        if (res.ok) {
          restored += 1;
          break;
        }
        // Serwer ogranicza liczbę dodawanych emoji na minutę – przy limicie czekamy i ponawiamy.
        if (/Zbyt wiele/.test(res.error || '')) await sleepMs(62000);
        else break; // np. nazwę zajęła już inna osoba – pomijamy
      }
      await sleepMs(600);
    }
  } finally {
    emojiRestoring = false;
  }
  if (restored) toast(`Przywrócono Twoje emoji (${restored}).`, true);
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
  card.appendChild(fileIconBox(m.mime, m.name));
  const info = el('div', 'filecard__info');
  info.appendChild(el('div', 'filecard__name', m.name));
  info.appendChild(el('div', 'filecard__size', formatSize(m.size) + (localFileIds.has(m.id) ? ' · zapisano lokalnie' : '')));
  card.appendChild(info);

  const inline = INLINE_IMAGE.test(m.mime) || INLINE_VIDEO.test(m.mime) || INLINE_AUDIO.test(m.mime);
  const btn = iconNode('button', 'icon-btn', inline ? 'eye' : 'download');
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
  card.appendChild(fileIconBox(m.mime, m.name));
  const info = el('div', 'filecard__info');
  info.appendChild(el('div', 'filecard__name', m.name));
  info.appendChild(el('div', 'filecard__size', formatSize(m.size)));
  card.appendChild(info);
  const dl = iconNode('a', 'icon-btn', 'download');
  dl.href = url;
  dl.download = m.name;
  dl.title = 'Pobierz';
  card.appendChild(dl);
  return card;
}


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

  // Odpowiedź zawsze zaczyna nową grupę (ma nad sobą odnośnik do oryginału).
  const hasReply = Boolean(m.replyTo);
  const first = hasReply || newDay || m.nick !== lastNick || m.time - lastMessageTime > GROUP_WINDOW_MS;
  // Podświetlamy wiadomości, w których oznaczono Ciebie (także przez odpowiedź do Ciebie) – poza Twoimi własnymi.
  const mentioned = !mine && (m.mentions || []).some((x) => identity.accountIds.has(x.id));
  const wrap = el(
    'div',
    'msg' +
      (first ? ' msg--first' : '') +
      (hasReply ? ' msg--reply' : '') +
      (mentioned ? ' msg--mentioned' : '') +
      (historic ? ' msg--static' : '')
  );
  wrap.dataset.time = m.time;
  wrap.dataset.nick = m.nick;
  wrap.dataset.account = m.accountId || '';
  if (m.id) wrap.dataset.id = m.id;

  if (hasReply) wrap.appendChild(makeReplyRef(m.replyTo));
  if (first) {
    wrap.appendChild(makeMessageAvatar(m.nick, m.accountId));
    wrap.appendChild(makeMessageHeader(m.nick, m.time, m.accountId));
  } else {
    wrap.appendChild(el('span', 'msg__hovertime', formatTime(m.time)));
  }

  if (m.id) {
    // Pasek akcji widoczny po najechaniu: odpowiedź i reakcja (każdy) oraz usunięcie (tylko autor)
    const actions = el('div', 'msg__actions');
    const answer = iconNode('button', 'msg__action', 'reply');
    answer.type = 'button';
    answer.title = 'Odpowiedz';
    answer.setAttribute('aria-label', 'Odpowiedz na wiadomość');
    answer.addEventListener('click', (e) => {
      e.stopPropagation();
      setReply({ id: m.id, nick: m.nick, accountId: m.accountId, preview: previewOfMessage(m) });
    });
    actions.appendChild(answer);

    const react = iconNode('button', 'msg__action js-react', 'smile');
    react.type = 'button';
    react.title = 'Dodaj reakcję';
    react.setAttribute('aria-label', 'Dodaj reakcję');
    react.addEventListener('click', (e) => {
      e.stopPropagation();
      openReactionPicker(m.id, react);
    });
    actions.appendChild(react);

    // Cudze wiadomości w grupie może usuwać też moderator (uprawnienie „Zarządzanie wiadomościami”).
    if (mine || hasGroupPerm(groupByChannel(currentChannel), 'manageMessages')) {
      const del = iconNode('button', 'msg__action msg__action--danger', 'trash');
      del.type = 'button';
      del.title = mine ? 'Usuń wiadomość' : 'Usuń wiadomość (moderacja)';
      del.setAttribute('aria-label', 'Usuń wiadomość');
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        requestDelete(m.id);
      });
      actions.appendChild(del);
    }
    wrap.appendChild(actions);
  }

  const afterMediaLoad = () => {
    if (stick) scrollToBottom();
  };

  if (m.kind === 'gif') {
    wrap.appendChild(makeGifBox(m.url, afterMediaLoad));
  } else if (m.kind === 'file') {
    wrap.appendChild(makeFileContent(m, afterMediaLoad));
  } else {
    const jumbo = isJumboMessage(m.text);
    const body = el('div', 'msg__text' + (jumbo ? ' msg__text--emoji' : ''));
    body.dataset.raw = m.text; // żeby po zmianie listy emoji dało się wiadomość narysować od nowa
    body._mentions = m.mentions || [];
    body.appendChild(renderRichText(m.text, jumbo, body._mentions));
    wrap.appendChild(body);
    for (const video of videosInText(m.text)) wrap.appendChild(makeVideoEmbed(video, afterMediaLoad));
  }

  wrap._reactions = m.reactions || {};
  renderReactions(wrap, wrap._reactions);

  messagesEl.appendChild(wrap);
  lastNick = m.nick;
  lastMessageTime = m.time;
  if (stick) scrollToBottom();
  if (!historic && m.kind !== 'gif' && m.kind !== 'file') pushCinemaFeed(m.nick, m.text);

  if (!mine && !historic) {
    beep(mentioned ? [880, 1175] : undefined);
    if (document.hidden) {
      unread += 1;
      document.title = appTitle(`(${unread}) MyChat`);
    }
  }
}

// ---------- Odpowiedzi ----------
// m.replyTo (z serwera): { id, nick, accountId, kind, preview } albo { id, missing: true }, gdy oryginału już nie ma.
function previewOfMessage(m) {
  if (m.kind === 'gif') return 'GIF';
  if (m.kind === 'file') return `Plik: ${m.name}`;
  return String(m.text || '').slice(0, 120);
}

function jumpToMessage(id) {
  const node = messagesEl.querySelector(`.msg[data-id="${CSS.escape(id)}"]`);
  if (!node) return toast('Tej wiadomości nie ma na ekranie – jest starsza niż wczytana historia.');
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.classList.remove('msg--flash');
  void node.offsetWidth; // pozwala odpalić animację od nowa
  node.classList.add('msg--flash');
  setTimeout(() => node.classList.remove('msg--flash'), 1700);
}

function fillReplyRef(row, ref) {
  row.classList.remove('msg__reply--missing');
  row.replaceChildren();
  row.appendChild(makeAvatar(ref.nick, ''));
  const nick = el('span', 'msg__reply-nick', `@${ref.nick}`);
  applyNickStyle(nick, ref.nick, ref.accountId);
  row.appendChild(nick);
  const text = el('span', 'msg__reply-text');
  text.appendChild(renderRichText(ref.preview || '', false));
  row.appendChild(text);
  row.onclick = () => jumpToMessage(ref.id);
}

function markReplyMissing(row) {
  row.classList.add('msg__reply--missing');
  row.replaceChildren(document.createTextNode('Oryginalna wiadomość została usunięta lub jest niedostępna'));
  row.onclick = null;
}

// Gdy serwer już nie ma oryginału, a Ty wciąż masz go w archiwum lokalnym, pokazujemy własną kopię.
async function localReplyOriginal(id) {
  const logged = sessionLog.get(id);
  if (logged) return logged;
  try {
    await archive.opening;
    return archive.ready ? await archive.getMessage(id) : null;
  } catch {
    return null;
  }
}

function makeReplyRef(ref) {
  const row = el('div', 'msg__reply');
  row.dataset.replyId = ref.id;
  if (!ref.missing) {
    fillReplyRef(row, ref);
    return row;
  }
  markReplyMissing(row);
  localReplyOriginal(ref.id).then((local) => {
    if (!local || !row.isConnected) return;
    fillReplyRef(row, { id: local.id, nick: local.nick, accountId: local.accountId, preview: previewOfMessage(local) });
    row.title = 'Kopia z Twojego archiwum lokalnego';
  });
  return row;
}

// Pasek nad polem wiadomości: „Odpowiadasz do …” z przełącznikiem powiadomienia autora i przyciskiem anulowania
let replyingTo = null; // { id, nick, accountId, preview }
let replyPing = true;

function renderReplyBar() {
  const bar = $('reply-bar');
  if (!replyingTo) {
    bar.classList.add('hidden');
    return bar.replaceChildren();
  }
  const text = el('span', 'replybar__text');
  text.appendChild(document.createTextNode('Odpowiadasz do '));
  const who = el('b', '', replyingTo.nick);
  applyNickStyle(who, replyingTo.nick, replyingTo.accountId);
  text.appendChild(who);
  text.appendChild(document.createTextNode(` — ${replyingTo.preview}`));

  const ping = el('button', 'ping-toggle' + (replyPing ? ' is-on' : ''), replyPing ? '@ WŁ.' : '@ WYŁ.');
  ping.type = 'button';
  ping.title = replyPing ? 'Autor dostanie powiadomienie – kliknij, żeby wyłączyć' : 'Autor nie dostanie powiadomienia – kliknij, żeby włączyć';
  ping.addEventListener('click', () => {
    replyPing = !replyPing;
    renderReplyBar();
  });

  const close = iconNode('button', 'icon-btn', 'close');
  close.type = 'button';
  close.title = 'Anuluj odpowiedź';
  close.addEventListener('click', clearReply);

  bar.replaceChildren(text, ping, close);
  bar.classList.remove('hidden');
}

function setReply(target) {
  replyingTo = target;
  replyPing = true;
  renderReplyBar();
  messageInput.focus();
}

function clearReply() {
  replyingTo = null;
  renderReplyBar();
}

// ---------- Reakcje ----------
// m.reactions: { emoji: { ids: [accountId…], nicks: [nicki do podpowiedzi] } }; emoji to znak Unicode albo :nazwa:
function reactionGlyph(emoji) {
  const custom = /^:([A-Za-z0-9_]{2,32}):$/.exec(emoji);
  const known = custom && emojiByName.get(custom[1].toLowerCase());
  if (known && isSafeImageSrc(known.url)) return emojiImg(known, false);
  return el('span', 'reaction__glyph', emoji);
}

function toggleReaction(messageId, emoji) {
  if (!messageId) return;
  socket.timeout(8000).emit('react', { id: messageId, emoji }, (err, res) => {
    if (err || !res || !res.ok) toast((res && res.error) || 'Nie udało się dodać reakcji.');
  });
}

function renderReactions(wrap, reactions) {
  let bar = wrap.querySelector('.reactions');
  const entries = Object.entries(reactions || {}).filter(([, r]) => r && r.ids && r.ids.length);
  if (!entries.length) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = el('div', 'reactions');
    wrap.appendChild(bar);
  }
  bar.replaceChildren(
    ...entries.map(([emoji, r]) => {
      const mine = r.ids.includes(myAccountId);
      const pill = el('button', 'reaction' + (mine ? ' reaction--mine' : ''));
      pill.type = 'button';
      pill.appendChild(reactionGlyph(emoji));
      pill.appendChild(el('span', 'reaction__count', String(r.ids.length)));
      const more = r.ids.length - r.nicks.length;
      pill.title = `${r.nicks.join(', ')}${more > 0 ? ` i ${more} więcej` : ''} — ${emoji}`;
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleReaction(wrap.dataset.id, emoji);
      });
      return pill;
    })
  );
}

function renderTyping() {
  const names = Array.from(typingUsers);
  if (names.length === 0) return typingEl.replaceChildren();
  const dots = el('span', 'dots');
  dots.append(el('i'), el('i'), el('i'));
  const label = names.length === 1 ? `${names[0]} pisze…` : `${names.join(', ')} piszą…`;
  typingEl.replaceChildren(dots, document.createTextNode(label));
}

// Panel po prawej: na kanałach ogólnych – kto jest online; w grupie – wszyscy jej członkowie (offline wyszarzeni).
let onlineUsers = []; // ostatnia lista „online” z serwera
let groupMembers = []; // członkowie oglądanej grupy
let groupMembersFor = null; // dla której grupy je pobrano

function renderMembersPanel() {
  const group = groupByChannel(currentChannel);
  if (!group) return renderMembers(onlineUsers);
  const online = new Map(onlineUsers.map((u) => [u.id, u]));
  const roles = group.roles || [];
  const topRoleOf = (m) => {
    const idx = (m.roles || []).map((id) => roles.findIndex((r) => r.id === id)).filter((i) => i !== -1);
    return idx.length ? Math.min(...idx) : -1;
  };
  const list = groupMembers
    .map((m) => ({ ...m, ...(online.get(m.id) || { status: 'offline' }), isOwner: m.isOwner, offline: !online.has(m.id), topRole: topRoleOf(m) }))
    .sort((a, b) => Number(a.offline) - Number(b.offline) || a.nick.localeCompare(b.nick, 'pl'));

  // Sekcje jak na Discordzie: twórca, potem role od najwyższej, na końcu osoby bez roli.
  const sections = [];
  const owners = list.filter((u) => u.isOwner);
  if (owners.length) sections.push({ title: 'TWÓRCA', items: owners });
  roles.forEach((role, i) => {
    const items = list.filter((u) => !u.isOwner && u.topRole === i);
    if (items.length) sections.push({ title: role.name.toUpperCase(), color: role.color, items });
  });
  const rest = list.filter((u) => !u.isOwner && u.topRole === -1);
  if (rest.length) sections.push({ title: roles.length || owners.length ? 'CZŁONKOWIE' : '', items: rest });
  renderMembers(list, { group, sections, roles });
}

function loadGroupMembers() {
  const group = groupByChannel(currentChannel);
  if (!group) return;
  socket.timeout(10000).emit('group:members', group.id, (err, res) => {
    const now = groupByChannel(currentChannel);
    if (err || !res || !res.ok || !now || now.id !== group.id) return;
    groupMembers = res.members;
    groupMembersFor = group.id;
    renderMembersPanel();
  });
}

function renderMembers(list, { group = null, sections = null, roles = [] } = {}) {
  list.forEach((u) => {
    avatars.set(u.nick, u.avatar);
    setNickStyle(u.id, u.nick, u);
  });
  const onlineCount = group ? list.filter((u) => !u.offline).length : list.length;
  onlineEl.textContent = `${onlineCount} online`;
  membersTitleEl.textContent = group ? `CZŁONKOWIE — ${list.length} (${onlineCount} online)` : `ONLINE — ${list.length}`;
  const nodes = [];
  const memberRow = (u, roleColor) => {
      const row = el('div', 'member' + (u.offline ? ' member--offline' : ''));
      markProfileTrigger(row, u.nick, u.id);
      const avatar = makeAvatar(u.nick, 'avatar--sm avatar--dot');
      avatar.dataset.status = u.status || 'online';
      row.appendChild(avatar);

      const text = el('div', 'member__text');
      const name = el('span', 'member__name', u.nick);
      applyNickStyle(name, u.nick, u.id);
      if (roleColor && !u.nickColor) {
        // kolor roli (jak na Discordzie), chyba że osoba ustawiła własny kolor nicku
        name.classList.remove('nick-styled');
        name.style.color = roleColor;
      }
      if (u.isOwner) {
        const crown = iconNode('span', 'member__crown', 'crown');
        crown.title = 'Twórca grupy';
        const nameRow = el('div', 'member__row');
        nameRow.append(name, crown);
        text.appendChild(nameRow);
      } else {
        text.appendChild(name);
      }
      if (u.statusText && !u.offline) text.appendChild(el('span', 'member__status', u.statusText));
      row.appendChild(text);
      return row;
  };

  if (sections) {
    sections.forEach((s) => {
      if (s.title) nodes.push(el('div', 'members__section', `${s.title} — ${s.items.length}`));
      s.items.forEach((u) => nodes.push(memberRow(u, s.color || (u.topRole >= 0 && roles[u.topRole] ? roles[u.topRole].color : null))));
    });
  } else {
    list.forEach((u) => nodes.push(memberRow(u, null)));
  }
  membersListEl.replaceChildren(...nodes);
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
    const edit = iconNode('button', 'btn-secondary btn-sm btn-iconly pcard__edit', 'pencil');
    edit.type = 'button';
    edit.title = 'Edytuj profil';
    edit.setAttribute('aria-label', edit.title);
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
        openSettings('profile');
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

// Czy w formularzu profilu są zmiany, których jeszcze nie zapisano?
function updateProfileDirty() {
  const keys = ['status', 'statusText', 'pronouns', 'bio', 'bannerColor', 'nickColor', 'nickFont'];
  const dirty = bannerChanged || keys.some((k) => (draft[k] ?? null) !== (myProfile[k] ?? null));
  const label = $('profile-dirty');
  label.textContent = dirty ? 'Masz niezapisane zmiany' : '';
  label.classList.toggle('is-dirty', dirty);
}

function updateProfilePreview() {
  if (!myNick) return;
  updateProfileDirty();
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
let appSoundsMuted = false; // wyciszone na czas seansu z czatem głosowym
let audioCtx;
function getAudioCtx() {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function beep(freqs = [660, 880]) {
  if (!settings.sound || appSoundsMuted) return;
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
  };
  socket.emit('join', payload, (res) => {
    if (!res || !res.ok) {
      myNick = null;
      serverSynced = false;
      groups = []; // bez zalogowania nie znamy grup – nie pokazujemy starej listy
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
    if (Array.isArray(res.emoji)) {
      setCustomEmoji(res.emoji); // własne emoji serwera – potrzebne, zanim dojdzie historia z wiadomościami
      if (res.maxEmoji) maxEmoji = res.maxEmoji;
    }
    groups = Array.isArray(res.groups) ? res.groups : []; // lista z serwera zastępuje wszystko, co znaliśmy wcześniej
    serverSynced = true;
    currentChannel = res.channel || null; // serwer mógł zmienić kanał (np. wyjście z grupy); null = brak grup
    store.set('mychat.channel', { id: currentChannel });
    renderPartyBar();
    voiceLists.clear();
    groupMembersFor = null;
    historyLoading = Boolean(currentChannel); // zaraz po zalogowaniu serwer wyśle historię kanału
    pendingLive.length = 0;
    if (currentChannel) {
      unreadChannels.delete(currentChannel);
      mentionCounts.delete(currentChannel);
    } else {
      messagesEl.replaceChildren();
    }
    renderChannels();
    if (groupByChannel(currentChannel)) loadGroupMembers();
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
    backupOwnEmoji().then(restoreMissingEmoji);

    // Po utracie połączenia wracamy na kanał głosowy (każda osoba robi to sama, więc rozmowa się odtwarza).
    if (voiceRejoin) {
      const rejoinGroup = voiceRejoin;
      voiceRejoin = null;
      joinVoice(rejoinGroup);
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
  socket.emit('message', replyingTo ? { text, replyTo: replyingTo.id, ping: replyPing } : text);
  clearReply();
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

// ---------- Emoji: wybieraczka (zwykłe i własne), reakcje, podpowiedzi, zarządzanie ----------
const EMOJIS =
  ('😀😃😄😁😆😅🤣😂🙂🙃😉😊😇🥰😍🤩😘😗😚😋😛😜🤪😝🤑🤗🤭🤫🤔🤐🤨😐😑😶😏😒🙄😬😮‍💨🤥😌😔😪🤤😴😷🤒🤕🤢🤮🤧🥵🥶🥴😵🤯🤠🥳😎🤓🧐😕😟🙁😮😯😲😳🥺😦😧😨😰😥😢😭😱😖😣😞😓😩😫🥱😤😡😠🤬😈👿💀💩🤡👻👽🤖' +
    '👍👎👌✌️🤞🤟🤘🤙👈👉👆👇☝️✋🤚🖐️🖖👋🤝👏🙌👐🤲🙏✍️💪🦾👀🧠' +
    '❤️🧡💛💚💙💜🖤🤍🤎💔❣️💕💞💓💗💖💘💝💯💢💥💫💦💨🔥✨⭐🌟🎉🎊🎁🏆🥇🎮🎯🎲🎵🎶🎤🎧⚽🏀🏈⚾🎾🏐' +
    '🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐷🐸🐵🐔🐧🐦🦆🦉🐺🐴🦄🐝🦋🐢🐍🐙🐬🐳🦈' +
    '🍎🍌🍉🍇🍓🍒🍑🍍🥑🌽🥕🍕🍔🍟🌭🍿🍩🍪🎂🍰🍫🍬🍺🍻🥂🍷☕🍵' +
    '🚀🚗✈️🏠🌍🌈☀️🌙⚡❄️🌊🌸🌹🍀' +
    '✅❌❓❗💬💭⚠️🔔🔒🔑💡📌📎💻📱📷🎬').match(
    /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu
  );
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

// Zawartość wybieraczki: zakładki „Emoji” i „Własne”; onPick dostaje znak Unicode albo :nazwa:.
function fillEmojiPicker(container, onPick, { quick = false } = {}) {
  const tabStd = iconNode('button', 'epicker__tab is-active', 'smile', 'Emoji');
  const tabCustom = iconNode('button', 'epicker__tab', 'star', `Własne (${customEmoji.length})`);
  tabStd.type = tabCustom.type = 'button';
  const tabs = el('div', 'epicker__tabs');
  tabs.append(tabStd, tabCustom);
  const grid = el('div', 'epicker__grid');

  const parts = [tabs];
  if (quick) {
    const row = el('div', 'epicker__quick');
    QUICK_REACTIONS.forEach((emoji) => {
      const b = el('button', '', emoji);
      b.type = 'button';
      b.addEventListener('click', () => onPick(emoji));
      row.appendChild(b);
    });
    parts.push(row);
  }
  parts.push(grid);
  container.replaceChildren(...parts);

  const showStandard = () => {
    tabStd.classList.add('is-active');
    tabCustom.classList.remove('is-active');
    grid.replaceChildren(
      ...EMOJIS.map((emoji) => {
        const b = el('button', '', emoji);
        b.type = 'button';
        b.addEventListener('click', () => onPick(emoji));
        return b;
      })
    );
  };
  const showCustom = () => {
    tabCustom.classList.add('is-active');
    tabStd.classList.remove('is-active');
    if (!customEmoji.length) {
      const empty = el('div', 'epicker__empty', 'Serwer nie ma jeszcze własnych emoji. ');
      const add = iconNode('button', 'btn-secondary btn-sm btn-iconly', 'plus');
      add.type = 'button';
      add.title = 'Dodaj pierwsze emoji';
      add.setAttribute('aria-label', add.title);
      add.addEventListener('click', () => {
        closePopups();
        openSettings('emoji');
      });
      empty.appendChild(add);
      return grid.replaceChildren(empty);
    }
    grid.replaceChildren(
      ...customEmoji.map((e) => {
        const b = el('button');
        b.type = 'button';
        b.title = `:${e.name}:`;
        b.appendChild(emojiImg(e, false));
        b.addEventListener('click', () => onPick(`:${e.name}:`));
        return b;
      })
    );
  };
  tabStd.addEventListener('click', showStandard);
  tabCustom.addEventListener('click', showCustom);
  showStandard();
}

// Wstawia tekst w miejscu kursora w polu wiadomości.
function insertIntoInput(text) {
  const start = messageInput.selectionStart ?? messageInput.value.length;
  const end = messageInput.selectionEnd ?? start;
  messageInput.setRangeText(text, start, end, 'end');
  messageInput.focus();
}

// --- Wybieraczka w polu wiadomości ---
function closePopups() {
  emojiPanel.classList.add('hidden');
  gifPanel.classList.add('hidden');
  $('emoji-btn').classList.remove('is-active');
  $('gif-btn').classList.remove('is-active');
  closeReactionPicker();
  closeEmojiSuggest();
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

$('emoji-btn').addEventListener('click', () => {
  if (togglePopup(emojiPanel, $('emoji-btn'))) {
    // własne emoji wstawiamy ze spacją, żeby od razu dało się pisać dalej
    fillEmojiPicker(emojiPanel, (token) => insertIntoInput(token.startsWith(':') ? `${token} ` : token));
  }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.popup, #emoji-btn, #gif-btn, .js-react')) closePopups();
});

// --- Wybieraczka reakcji przy wiadomości ---
let reactionTarget = null;

function closeReactionPicker() {
  document.getElementById('reaction-picker')?.remove();
  reactionTarget = null;
}

function openReactionPicker(messageId, anchor) {
  const same = reactionTarget === messageId;
  closePopups();
  if (same) return; // drugie kliknięcie tego samego przycisku zamyka
  const panel = el('div', 'popup popup--emoji popup--float');
  panel.id = 'reaction-picker';
  fillEmojiPicker(
    panel,
    (emoji) => {
      toggleReaction(messageId, emoji);
      closeReactionPicker();
    },
    { quick: true }
  );
  document.body.appendChild(panel);
  reactionTarget = messageId;

  const r = anchor.getBoundingClientRect();
  const w = panel.offsetWidth;
  const h = panel.offsetHeight;
  const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6); // brak miejsca pod spodem – nad przyciskiem
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

// --- Podpowiedzi przy wpisywaniu: :nazwa (własne emoji) i @nick (osoby), jak na Discordzie ---
const suggestEl = $('emoji-suggest');
let suggestKind = 'emoji'; // 'emoji' albo 'member'
let suggestMatches = [];
let suggestIndex = 0;
let suggestQuery = '';
let memberSearchTimer = null;
let memberSearchSeq = 0;

function hideSuggest() {
  suggestEl.classList.add('hidden');
  suggestMatches = [];
}

function closeEmojiSuggest() {
  hideSuggest();
  clearTimeout(memberSearchTimer);
  memberSearchSeq += 1; // spóźnione odpowiedzi wyszukiwania osób są ignorowane
}

function renderSuggest() {
  const isMember = suggestKind === 'member';
  const title = el('div', 'suggest__title', isMember ? `LUDZIE „@${suggestQuery}”` : `EMOJI PASUJĄCE DO „:${suggestQuery}”`);
  const items = suggestMatches.map((item, i) => {
    const b = el('button', 'suggest__item' + (i === suggestIndex ? ' is-selected' : ''));
    b.type = 'button';
    b.setAttribute('role', 'option');
    if (isMember) {
      avatars.set(item.nick, item.avatar);
      b.appendChild(makeAvatar(item.nick, 'avatar--sm'));
      const name = el('span', 'suggest__name', item.nick);
      applyNickStyle(name, item.nick, item.id);
      b.appendChild(name);
      b.appendChild(el('span', 'suggest__meta', item.online ? 'online' : 'offline'));
    } else {
      b.appendChild(emojiImg(item, false));
      b.appendChild(el('span', '', `:${item.name}:`));
    }
    b.addEventListener('mousedown', (ev) => ev.preventDefault()); // nie zabieraj fokusu polu wiadomości
    b.addEventListener('click', () => applySuggestion(item));
    return b;
  });
  suggestEl.replaceChildren(title, ...items);
  suggestEl.classList.remove('hidden');
}

// Osoby do wzmianki wyszukuje serwer (zna wszystkie konta; osoby online są na początku listy).
function updateMemberSuggest(query) {
  clearTimeout(memberSearchTimer);
  const seq = ++memberSearchSeq;
  memberSearchTimer = setTimeout(() => {
    socket.timeout(5000).emit('mention:search', query, (err, res) => {
      if (seq !== memberSearchSeq || err || !res || !res.ok) return;
      if (!res.results.length) return hideSuggest();
      const q = query.toLowerCase();
      if (suggestKind !== 'member' || q !== suggestQuery) suggestIndex = 0;
      suggestKind = 'member';
      suggestQuery = q;
      suggestMatches = res.results;
      suggestIndex = Math.min(suggestIndex, res.results.length - 1);
      renderSuggest();
    });
  }, 120);
}

function updateEmojiSuggest() {
  const caret = messageInput.selectionStart ?? messageInput.value.length;
  const before = messageInput.value.slice(0, caret);

  const memberMatch = /(?:^|\s)@([^\s@]{0,20})$/.exec(before);
  if (memberMatch) return updateMemberSuggest(memberMatch[1]);

  const match = /(?:^|\s):([A-Za-z0-9_]{2,})$/.exec(before);
  if (!match || !customEmoji.length) return closeEmojiSuggest();

  const q = match[1].toLowerCase();
  const starts = (e) => (e.name.toLowerCase().startsWith(q) ? 0 : 1);
  const found = customEmoji
    .filter((e) => e.name.toLowerCase().includes(q))
    .sort((a, b) => starts(a) - starts(b) || a.name.localeCompare(b.name))
    .slice(0, 8);
  if (!found.length) return closeEmojiSuggest();

  memberSearchSeq += 1;
  clearTimeout(memberSearchTimer);
  if (suggestKind !== 'emoji' || q !== suggestQuery) suggestIndex = 0;
  suggestKind = 'emoji';
  suggestQuery = q;
  suggestMatches = found;
  suggestIndex = Math.min(suggestIndex, found.length - 1);
  renderSuggest();
}

function applySuggestion(item) {
  const caret = messageInput.selectionStart ?? messageInput.value.length;
  const typed = messageInput.value.slice(0, caret);
  // funkcja zamiast tekstu zastępczego: nick lub nazwa mogłyby zawierać znaki specjalne ($&)
  const before =
    suggestKind === 'member'
      ? typed.replace(/@([^\s@]{0,20})$/, () => `@${item.nick} `)
      : typed.replace(/:([A-Za-z0-9_]{2,})$/, () => `:${item.name}: `);
  messageInput.value = before + messageInput.value.slice(caret);
  messageInput.setSelectionRange(before.length, before.length);
  closeEmojiSuggest();
  messageInput.focus();
}

messageInput.addEventListener('input', updateEmojiSuggest);
messageInput.addEventListener('click', updateEmojiSuggest);
messageInput.addEventListener('keydown', (e) => {
  if (suggestEl.classList.contains('hidden') || !suggestMatches.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    suggestIndex = (suggestIndex + (e.key === 'ArrowDown' ? 1 : -1) + suggestMatches.length) % suggestMatches.length;
    renderSuggest();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault(); // Enter wybiera podpowiedź zamiast wysyłać wiadomość
    applySuggestion(suggestMatches[suggestIndex]);
  } else if (e.key === 'Escape') {
    closeEmojiSuggest();
  }
});

// --- Reakcje i lista emoji z serwera ---
socket.on('reactions', ({ id, reactions }) => {
  const node = messagesEl.querySelector(`.msg[data-id="${CSS.escape(id)}"]`);
  if (node) {
    node._reactions = reactions;
    renderReactions(node, reactions);
  }
  const logged = sessionLog.get(id);
  if (logged) {
    logged.reactions = reactions;
    if (settings.archive && archive.ready) archive.put([logged]).catch(handleArchiveError);
  }
});

// Po zmianie listy emoji rysujemy od nowa teksty wiadomości (:nazwa: ↔ obrazek) i reakcje.
function refreshEmojiViews() {
  messagesEl.querySelectorAll('.msg__text[data-raw]').forEach((body) => {
    const raw = body.dataset.raw;
    const jumbo = isJumboMessage(raw);
    body.classList.toggle('msg__text--emoji', jumbo);
    body.replaceChildren(renderRichText(raw, jumbo, body._mentions || []));
  });
  messagesEl.querySelectorAll('.msg').forEach((wrap) => {
    if (wrap._reactions && Object.keys(wrap._reactions).length) renderReactions(wrap, wrap._reactions);
  });
  renderEmojiSettings();
}

socket.on('emoji:list', (list) => {
  setCustomEmoji(list);
  refreshEmojiViews();
});

// --- Zarządzanie emoji (Ustawienia → Emoji) ---
const emojiDraft = { image: null, note: '' };

function renderEmojiSettings() {
  $('emoji-count').textContent = `${customEmoji.length}/${maxEmoji}`;
  updateEmojiAddState(); // lista się zmieniła (np. ktoś dodał emoji o tej samej nazwie) – odśwież podpowiedź
  const list = $('emoji-list');
  if (!customEmoji.length) {
    return list.replaceChildren(el('div', 'emoji-empty', 'Nie ma jeszcze żadnych własnych emoji – dodaj pierwsze powyżej!'));
  }
  list.replaceChildren(
    ...customEmoji.map((e) => {
      const card = el('div', 'emoji-card');
      card.appendChild(emojiImg(e, false));
      const text = el('div', 'emoji-card__text');
      text.appendChild(el('div', 'emoji-card__name', `:${e.name}:`));
      text.appendChild(el('div', 'emoji-card__by', e.by ? `dodał(a) ${e.by}` : ''));
      card.appendChild(text);
      if (e.byId && e.byId === myAccountId) {
        const del = iconNode('button', 'icon-btn icon-btn--danger', 'trash');
        del.type = 'button';
        del.title = 'Usuń emoji';
        del.addEventListener('click', () => {
          if (!confirm(`Usunąć emoji :${e.name}:? Zniknie dla wszystkich.`)) return;
          socket.timeout(10000).emit('emoji:delete', e.id, (err, res) => {
            if (err || !res || !res.ok) return toast((res && res.error) || 'Nie udało się usunąć emoji.');
            // usunięte celowo – nie odtwarzamy go potem z kopii
            backup.emoji = backup.emoji.filter((x) => x.name.toLowerCase() !== e.name.toLowerCase());
            backup.saveEmojiList();
          });
        });
        card.appendChild(del);
      }
      return card;
    })
  );
}

// Pierwsza wolna nazwa: „emoji”, jeśli zajęta – „emoji_2”, „emoji_3”… (pliki często mają tę samą nazwę, np. image.png)
function uniqueEmojiName(base) {
  const root = base.slice(0, 28);
  let name = base;
  for (let n = 2; emojiByName.has(name.toLowerCase()) && n < 1000; n += 1) name = `${root}_${n}`;
  return name;
}

// Pokazuje, czego brakuje do dodania emoji – zamiast przycisku, który po prostu nie działa, i znikającego komunikatu.
function updateEmojiAddState(serverError) {
  const name = $('emoji-add-name').value.trim();
  const hint = $('emoji-add-hint');
  let message = 'Gotowe – kliknij „Dodaj emoji”.';
  let level = 'is-ok';
  let ready = false;

  if (!emojiDraft.image) {
    message = 'Najpierw wybierz obraz.';
    level = '';
  } else if (name.length < 2) {
    message = 'Wpisz nazwę (co najmniej 2 znaki: litery bez polskich znaków, cyfry lub _).';
    level = 'is-warn';
  } else if (emojiByName.has(name.toLowerCase())) {
    message = `Emoji :${name}: już istnieje – zmień nazwę.`;
    level = 'is-warn';
  } else if (customEmoji.length >= maxEmoji) {
    message = `Serwer ma już maksymalną liczbę emoji (${maxEmoji}). Usuń któreś, żeby dodać nowe.`;
    level = 'is-warn';
  } else {
    ready = true;
    if (emojiDraft.note) message = `${emojiDraft.note} ${message}`;
  }
  if (serverError) {
    message = serverError;
    level = 'is-warn';
  }
  hint.textContent = message;
  hint.className = `emoji-add__hint ${level}`.trim();
  $('emoji-add-save').disabled = !ready;
}

// ---------- Obraz emoji: statyczny albo animowany ----------
// Typ rozpoznajemy po zawartości pliku, a nie po rozszerzeniu (animacje z internetu często są .webp albo mają złe rozszerzenie).
//  • animacja do 256 KB (GIF, animowany WebP, APNG) zostaje bez zmian – animacja się nie psuje,
//  • większa animacja jest zmniejszana do GIF-a (potrafią to Chrome/Edge),
//  • zwykły obraz jest zmniejszany do 128x128 z zachowaniem przezroczystości.
const EMOJI_ANIM_LIMIT = 256 * 1024; // limit serwera dla animowanych emoji
const EMOJI_ANIM_TARGET = 240 * 1024; // do tylu bajtów zmniejszamy (z zapasem na base64)

function sniffImageType(bytes) {
  const ascii = (from, to) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length > 12 && ascii(0, 4) === 'GIF8') return 'image/gif';
  if (bytes.length > 12 && bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (bytes.length > 20 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function isAnimatedImage(type, bytes) {
  const ascii = (from, to) => String.fromCharCode(...bytes.subarray(from, to));
  if (type === 'image/gif') return true;
  if (type === 'image/webp') return ascii(12, 16) === 'VP8X' && (bytes[20] & 0x02) !== 0; // bit „animacja” w nagłówku
  if (type === 'image/png') {
    // APNG ma fragment „acTL” przed danymi obrazu (IDAT)
    for (let pos = 8; pos + 8 <= bytes.length; ) {
      const length = ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
      const name = ascii(pos + 4, pos + 8);
      if (name === 'acTL') return true;
      if (name === 'IDAT' || name === 'IEND') return false;
      pos += 12 + length;
    }
  }
  return false;
}

// --- Minimalny koder GIF (do zmniejszania zbyt dużych animacji) ---
function lzwEncode(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const out = [];
  let codeSize = minCodeSize + 1;
  let next = end + 1;
  let dict = new Map();
  let buffer = 0;
  let bits = 0;
  const emit = (code) => {
    buffer |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      out.push(buffer & 255);
      buffer >>>= 8;
      bits -= 8;
    }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const key = (prefix << 8) | indices[i];
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next);
      next += 1;
      if (next > 1 << codeSize && codeSize < 12) codeSize += 1;
    } else {
      emit(clear);
      dict = new Map();
      codeSize = minCodeSize + 1;
      next = end + 1;
    }
    prefix = indices[i];
  }
  emit(prefix);
  emit(end);
  if (bits > 0) out.push(buffer & 255);
  return out;
}

// Paleta 255 kolorów metodą „median cut” (indeks 255 zostaje na przezroczystość)
function buildPalette(frames) {
  const histogram = new Map(); // klucz 15-bitowy -> liczba pikseli
  for (const px of frames) {
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 128) continue;
      const key = ((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3);
      histogram.set(key, (histogram.get(key) || 0) + 1);
    }
  }
  const colors = Array.from(histogram, ([key, count]) => ({
    r: ((key >> 10) << 3) + 4,
    g: (((key >> 5) & 31) << 3) + 4,
    b: ((key & 31) << 3) + 4,
    count,
  }));
  if (!colors.length) return [[0, 0, 0]];

  let boxes = [colors];
  while (boxes.length < 255) {
    // dzielimy pudełko o największej rozpiętości kanału (i większej od jednego koloru)
    let best = -1;
    let bestRange = 0;
    let bestChannel = 'r';
    boxes.forEach((box, index) => {
      if (box.length < 2) return;
      for (const channel of ['r', 'g', 'b']) {
        let min = 255;
        let max = 0;
        for (const c of box) {
          if (c[channel] < min) min = c[channel];
          if (c[channel] > max) max = c[channel];
        }
        if (max - min > bestRange) {
          bestRange = max - min;
          best = index;
          bestChannel = channel;
        }
      }
    });
    if (best < 0) break;
    const box = boxes[best].sort((a, b) => a[bestChannel] - b[bestChannel]);
    const half = box.reduce((sum, c) => sum + c.count, 0) / 2;
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.length - 1; i += 1) {
      acc += box[i].count;
      cut = i + 1;
      if (acc >= half) break;
    }
    boxes.splice(best, 1, box.slice(0, cut), box.slice(cut));
  }
  return boxes.map((box) => {
    const total = box.reduce((sum, c) => sum + c.count, 0);
    const avg = (channel) => Math.round(box.reduce((sum, c) => sum + c[channel] * c.count, 0) / total);
    return [avg('r'), avg('g'), avg('b')];
  });
}

// frames: [{ pixels: Uint8ClampedArray(RGBA), delay: setne sekundy }] o rozmiarze size x size
function encodeGif(frames, size) {
  const palette = buildPalette(frames.map((f) => f.pixels));
  const cache = new Map();
  const nearest = (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let found = cache.get(key);
    if (found === undefined) {
      let bestDistance = Infinity;
      found = 0;
      palette.forEach(([pr, pg, pb], index) => {
        const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
        if (d < bestDistance) {
          bestDistance = d;
          found = index;
        }
      });
      cache.set(key, found);
    }
    return found;
  };

  const bytes = [];
  const word = (n) => bytes.push(n & 255, (n >> 8) & 255);
  bytes.push(...'GIF89a'.split('').map((c) => c.charCodeAt(0)));
  word(size);
  word(size);
  bytes.push(0xf7, 0, 0); // globalna tablica kolorów: 256 pozycji
  for (let i = 0; i < 256; i += 1) bytes.push(...(palette[i] || [0, 0, 0]));
  bytes.push(0x21, 0xff, 0x0b, ...'NETSCAPE2.0'.split('').map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0); // zapętlenie

  for (const frame of frames) {
    const px = frame.pixels;
    const indices = new Uint8Array(size * size);
    for (let i = 0, j = 0; i < px.length; i += 4, j += 1) {
      indices[j] = px[i + 3] < 128 ? 255 : nearest(px[i], px[i + 1], px[i + 2]);
    }
    bytes.push(0x21, 0xf9, 4, (2 << 2) | 1); // sterowanie klatką: przezroczystość + czyszczenie tła
    word(frame.delay);
    bytes.push(255, 0);
    bytes.push(0x2c);
    word(0);
    word(0);
    word(size);
    word(size);
    bytes.push(0, 8); // minimalny rozmiar kodu LZW
    const data = lzwEncode(indices, 8);
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255);
      bytes.push(chunk.length, ...chunk);
    }
    bytes.push(0);
  }
  bytes.push(0x3b);
  return new Uint8Array(bytes);
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// Duża animacja (GIF / animowany WebP / APNG) -> mały GIF. Wymaga ImageDecoder (Chrome, Edge).
async function shrinkAnimationToGif(bytes, type) {
  if (!('ImageDecoder' in window)) {
    throw new Error(
      'Ta animacja ma ponad 256 KB. Zmniejsz ją (np. na ezgif.com) albo dodaj emoji w Chrome/Edge – tam zmniejszy się sama.'
    );
  }
  const decoder = new ImageDecoder({ data: bytes, type });
  await decoder.tracks.ready;
  const total = decoder.tracks.selectedTrack.frameCount || 1;
  const step = Math.max(1, Math.ceil(total / 60)); // do 60 klatek, równomiernie
  const decoded = [];
  for (let index = 0; index < total; index += step) {
    const { image } = await decoder.decode({ frameIndex: index });
    decoded.push({ bitmap: await createImageBitmap(image), ms: Math.max(20, (image.duration || 100000) / 1000) * step });
    image.close();
  }
  decoder.close();

  // Coraz mniejszy rozmiar i coraz mniej klatek, aż zmieści się w limicie.
  const attempts = [
    [128, 1], [96, 1], [96, 2], [72, 2], [64, 3], [48, 3],
  ];
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  try {
    for (const [size, skip] of attempts) {
      canvas.width = canvas.height = size;
      const frames = [];
      for (let i = 0; i < decoded.length; i += skip) {
        const { bitmap } = decoded[i];
        const group = decoded.slice(i, i + skip);
        ctx.clearRect(0, 0, size, size);
        const scale = Math.min(size / bitmap.width, size / bitmap.height);
        const w = Math.round(bitmap.width * scale);
        const h = Math.round(bitmap.height * scale);
        ctx.drawImage(bitmap, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);
        frames.push({
          pixels: ctx.getImageData(0, 0, size, size).data,
          delay: Math.max(2, Math.round(group.reduce((sum, f) => sum + f.ms, 0) / 10)), // setne sekundy; <2 przeglądarki spowalniają
        });
      }
      const gif = encodeGif(frames, size);
      if (gif.length <= EMOJI_ANIM_TARGET) {
        return { dataUrl: `data:image/gif;base64,${bytesToBase64(gif)}`, bytes: gif.length, size };
      }
    }
  } finally {
    decoded.forEach((f) => f.bitmap.close());
  }
  throw new Error('Nie udało się zmniejszyć tej animacji do 256 KB – wybierz krótszą lub prostszą.');
}

// Zwykły (nieruchomy) obraz: do 128x128 z przezroczystością, w PNG albo WebP, tak by zmieścił się w limicie.
function staticToEmoji(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      for (const size of [128, 96, 64]) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const scale = Math.min(size / img.width, size / img.height);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);
        for (const type of ['image/png', 'image/webp']) {
          const dataUrl = canvas.toDataURL(type, 0.9);
          if (dataUrl.startsWith(`data:${type}`) && dataUrl.length <= 95000) return resolve(dataUrl);
        }
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

// Zwraca { dataUrl, animated, note } – note to krótka informacja dla użytkownika (np. o zmniejszeniu animacji).
async function fileToEmoji(file) {
  if (!file || !file.type.startsWith('image/')) throw new Error('To nie jest obrazek.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffImageType(bytes);

  if (type && isAnimatedImage(type, bytes)) {
    if (bytes.length <= EMOJI_ANIM_LIMIT) {
      // mała animacja zostaje w oryginale (typ z zawartości pliku, nie z rozszerzenia)
      const dataUrl = await readAsDataUrl(new Blob([bytes], { type }));
      return { dataUrl, animated: true, note: `Animowane emoji (${formatSize(bytes.length)}).` };
    }
    const result = await shrinkAnimationToGif(bytes, type);
    return {
      dataUrl: result.dataUrl,
      animated: true,
      note: `Animację zmniejszono z ${formatSize(bytes.length)} do ${formatSize(result.bytes)} (${result.size}×${result.size}).`,
    };
  }
  return { dataUrl: await staticToEmoji(file), animated: false, note: '' };
}

$('emoji-add-pick').addEventListener('click', () => $('emoji-add-file').click());
$('emoji-add-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    $('emoji-add-hint').className = 'emoji-add__hint';
    $('emoji-add-hint').textContent = 'Przetwarzanie obrazu…'; // zmniejszanie dużej animacji potrafi chwilę potrwać
    const result = await fileToEmoji(file);
    emojiDraft.image = result.dataUrl;
    emojiDraft.note = result.note;
    const preview = $('emoji-add-preview');
    preview.style.backgroundImage = `url("${emojiDraft.image}")`;
    preview.textContent = '';
    if (!$('emoji-add-name').value.trim()) {
      // nazwa z nazwy pliku: tylko litery, cyfry i podkreślenia
      const guess = file.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
      // zajęta nazwa dostaje numer (emoji → emoji_2), żeby kolejne pliki o tej samej nazwie dało się dodać
      $('emoji-add-name').value = guess.length >= 2 ? uniqueEmojiName(guess) : '';
    }
  } catch (err) {
    emojiDraft.image = null;
    emojiDraft.note = '';
    updateEmojiAddState(err.message); // powód widać pod formularzem
    return toast(err.message);
  }
  updateEmojiAddState();
});
$('emoji-add-name').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/[^A-Za-z0-9_]/g, ''); // nazwa tylko z liter bez polskich znaków, cyfr i _
  updateEmojiAddState();
});
$('emoji-add-save').addEventListener('click', () => {
  const name = $('emoji-add-name').value.trim();
  const btn = $('emoji-add-save');
  btn.disabled = true;
  socket.timeout(20000).emit('emoji:add', { name, image: emojiDraft.image }, (err, res) => {
    if (err || !res || !res.ok) {
      const reason = (res && res.error) || 'Nie udało się dodać emoji (brak odpowiedzi serwera).';
      updateEmojiAddState(reason); // powód zostaje pod formularzem, nie znika jak komunikat
      return toast(reason);
    }
    toast(`Dodano emoji :${name}:`, true);
    // kopia w przeglądarce – żeby emoji dało się odtworzyć, gdy serwer straci dane
    backup.emoji = backup.emoji.filter((x) => x.name.toLowerCase() !== name.toLowerCase());
    backup.emoji.push({ name, image: emojiDraft.image });
    backup.saveEmojiList();
    emojiDraft.image = null;
    emojiDraft.note = '';
    $('emoji-add-name').value = '';
    const preview = $('emoji-add-preview');
    preview.style.backgroundImage = '';
    preview.textContent = '?';
    updateEmojiAddState();
  });
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
    if (request !== gifRequest || gifTab !== 'search') return;
    gifGrid.replaceChildren(
      ...list.map((g) => {
        const cell = el('div', 'gif-cell');
        const img = el('img');
        img.src = g.preview;
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        img.alt = 'GIF';
        img.addEventListener('click', () => sendGif(g.url));
        cell.append(img, makeGifFavButton(g.url));
        return cell;
      })
    );
    gifHint.textContent = list.length ? 'Obsługiwane przez GIPHY' : 'Brak wyników.';
  } catch {
    if (request !== gifRequest || gifTab !== 'search') return;
    gifGrid.replaceChildren();
    gifHint.textContent = 'Nie udało się pobrać GIFów. Możesz wkleić link poniżej.';
  }
}

// Zakładki panelu: wyszukiwarka i ulubione (małe podglądy).
let gifTab = 'search';
const gifTabSearch = $('gif-tab-search');
const gifTabFavs = $('gif-tab-favs');

function renderGifTabs() {
  gifTabSearch.classList.toggle('is-active', gifTab === 'search');
  gifTabFavs.classList.toggle('is-active', gifTab === 'favs');
  gifTabFavs.replaceChildren(icon('star'), document.createTextNode(` Ulubione (${gifFavs().length})`));
}

function renderGifFavs() {
  const list = gifFavs();
  gifGrid.classList.add('gif-grid--favs');
  gifGrid.replaceChildren(
    ...list.map((url) => {
      const cell = el('div', 'gif-cell');
      const img = el('img');
      img.src = url;
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.alt = 'Ulubiony GIF';
      img.addEventListener('click', () => sendGif(url));
      img.addEventListener('error', () => cell.classList.add('gif-cell--broken'));
      const remove = iconNode('button', 'giffav gif-cell__remove', 'close');
      remove.type = 'button';
      remove.title = 'Usuń z ulubionych';
      remove.setAttribute('aria-label', remove.title);
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleGifFav(url);
      });
      cell.append(img, remove);
      return cell;
    })
  );
  gifHint.textContent = list.length
    ? 'Kliknij GIFa, aby go wysłać. ✕ usuwa z ulubionych.'
    : 'Nie masz jeszcze ulubionych GIFów – kliknij gwiazdkę w prawym górnym rogu GIFa w czacie.';
}

function showGifTab(tab) {
  gifTab = tab;
  renderGifTabs();
  gifRequest += 1; // spóźniona odpowiedź wyszukiwarki nie nadpisze ulubionych
  if (tab === 'favs') {
    gifSearch.classList.add('hidden');
    renderGifFavs();
    return;
  }
  gifGrid.classList.remove('gif-grid--favs');
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
}
gifTabSearch.addEventListener('click', () => showGifTab('search'));
gifTabFavs.addEventListener('click', () => showGifTab('favs'));
document.addEventListener('gifs-changed', () => {
  renderGifTabs();
  if (gifTab === 'favs' && !gifPanel.classList.contains('hidden')) renderGifFavs();
});

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
  // bez wyszukiwarki (brak klucza) i z zapisanymi ulubionymi od razu pokazujemy ulubione
  showGifTab(!gifSearchEnabled && gifFavs().length ? 'favs' : gifTab);
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
// Kategorie ustawień: pokazujemy jedną na raz (zamiast jednej długiej listy do przewijania).
const SETTINGS_PROFILE_TABS = new Set(['profile', 'nick']); // te dwie mają podgląd karty i przycisk zapisu
let settingsTab = 'account';

function showSettingsTab(name) {
  settingsTab = name;
  document.querySelectorAll('.settings__tab').forEach((btn) => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.settings__pane').forEach((pane) => {
    pane.hidden = pane.dataset.pane !== name;
  });
  const profileTab = SETTINGS_PROFILE_TABS.has(name);
  $('settings-preview').hidden = !profileTab;
  $('profile-footer').hidden = !profileTab;
  document.querySelector('.settings__panes').scrollTop = 0;
}

document.querySelectorAll('.settings__tab').forEach((btn) => {
  btn.addEventListener('click', () => showSettingsTab(btn.dataset.tab));
});

// `tab` bywa zdarzeniem kliknięcia (gdy funkcja jest podpięta jako obsługa) – przyjmujemy tylko nazwę kategorii.
function openSettings(tab) {
  closeProfilePopout();
  loadProfileForm();
  renderSettingsOptions();
  renderEmojiSettings();
  showSettingsTab(typeof tab === 'string' ? tab : settingsTab);
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
const saveSetting = (key, value) => {
  settings[key] = value;
  store.set('mychat.settings', settings);
};
$('party-glow').addEventListener('change', (e) => saveSetting('partyGlow', e.target.value));
$('one-hand').addEventListener('change', (e) => {
  saveSetting('oneHand', e.target.value);
  applyOneHand();
  if (miniPlayer && miniPlayer._applyLayout) miniPlayer._applyLayout(); // otwarte okno od razu zmienia układ
  if (e.target.value !== 'off') toast('Przyciski odtwarzaczy są teraz na dole, po stronie kciuka (tylko na telefonie).', true);
});
$('party-emoji').addEventListener('change', (e) => {
  saveSetting('partyEmoji', e.target.value);
  e.target.value = reactionSet().join(''); // pokazujemy to, co faktycznie zostanie użyte
});
$('party-sounds-toggle').addEventListener('change', (e) => saveSetting('partySounds', e.target.checked));
$('party-voice-toggle').addEventListener('change', (e) => saveSetting('partyVoice', e.target.checked));
$('keep-awake-toggle').addEventListener('change', (e) => saveSetting('keepAwake', e.target.checked));
$('discreet-toggle').addEventListener('change', (e) => {
  saveSetting('discreet', e.target.checked);
  applyDiscreet();
  if (e.target.checked) toast('Tryb dyskretny: klawisz H ukrywa multimedia, a przy zmianie karty ukrywają się same.', true);
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
      return `[${when}] #${m.channel || ''} ${m.nick}: ${describeMessage(m)}`;
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
  clearReply();
  closeProfilePopout();
  closeSettings();
  closePopups();
  lightbox.classList.add('hidden');
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    unread = 0;
    document.title = appTitle('MyChat');
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
  groupId: null, // grupa, do której kanału głosowego jesteśmy podłączeni (każda grupa ma własny)
  users: [], // [{ id, nick, muted, deafened, sharing }] – osoby z NASZEGO kanału głosowego
  peers: new Map(), // socket.id -> { pc, pending, audio }
};
const voiceLists = new Map(); // groupId -> osoby na kanale głosowym każdej z Twoich grup (do panelu bocznego)

let voiceRejoin = null; // id grupy, w której byliśmy na kanale głosowym, gdy zerwało się połączenie z serwerem
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
  const list = voice.users; // pasek rozmowy: nasz kanał głosowy
  const viewed = myCurrentGroup();
  const sidebar = viewed ? voiceLists.get(viewed.id) || [] : []; // panel boczny: kanał głosowy oglądanej grupy
  $('voice-count').textContent = sidebar.length ? `${sidebar.length}/${maxVoiceUsers}` : '';

  // Znaczki przy osobie: czerwone LIVE (udostępnia ekran) oraz wyciszenie / wyłączony dźwięk
  const flags = (u) => {
    const nodes = [];
    if (u.sharing) nodes.push(el('span', 'voice-live', 'LIVE'));
    if (u.deafened) nodes.push(voiceFlag('headphones-off', 'Dźwięk wyłączony'));
    else if (u.muted) nodes.push(voiceFlag('mic-off', 'Wyciszony'));
    return nodes;
  };

  $('voice-members').replaceChildren(
    ...sidebar.map((u) => {
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
  const inViewedVoice = voice.active && Boolean(myCurrentGroup()) && voice.groupId === myCurrentGroup().id;
  $('voice-btn').title = inViewedVoice ? 'Rozłącz z kanałem głosowym' : 'Dołącz do kanału głosowego';
  $('voice-channel').classList.toggle('is-connected', inViewedVoice);
  const voiceGroup = voice.active ? groups.find((g) => g.id === voice.groupId) : null;
  $('voice-status').textContent = voiceGroup ? `Kanał głosowy: ${voiceGroup.name}` : 'Połączono z kanałem głosowym';
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
    const full = iconNode('button', 'icon-btn', 'expand');
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

// Kafelek cudzego ekranu istnieje, gdy serwer mówi, że osoba nadaje, i mamy od niej strumień. Nadajniki są
// używane wielokrotnie, więc kolejne udostępnianie nie wywołuje nowego `ontrack` – stąd stan z serwera.
function syncScreen(id) {
  const peer = voice.peers.get(id);
  const user = voice.users.find((u) => u.id === id);
  if (peer && peer.screenStream && user && user.sharing) {
    showScreen(id, peer.screenStream, `${user.nick} udostępnia ekran`);
  } else {
    removeScreen(id);
  }
}

function removeScreen(key) {
  const entry = screens.get(key);
  if (!entry) return;
  entry.video.srcObject = null;
  entry.tile.remove();
  screens.delete(key);
  updateScreenView();
}

// ---------- Jakość udostępniania ekranu ----------
// Obraz idzie osobno do każdego widza (bezpośrednio, bez serwera), więc im więcej widzów, tym mniej przepływności
// przypada na jednego. `total` to budżet łącza wysyłania, a `perViewer` – maksimum dla pojedynczego widza.
const SCREEN_PRESETS = {
  low: { name: 'Oszczędna – 720p, 30 kl./s', width: 1280, height: 720, fps: 30, perViewer: 1_500_000, total: 4_000_000 },
  standard: { name: 'Standard – 1080p, 30 kl./s', width: 1920, height: 1080, fps: 30, perViewer: 3_000_000, total: 8_000_000 },
  high: { name: 'Wysoka – 1080p, 60 kl./s', width: 1920, height: 1080, fps: 60, perViewer: 6_000_000, total: 14_000_000 },
  ultra: { name: 'Maksymalna – 1440p, 60 kl./s', width: 2560, height: 1440, fps: 60, perViewer: 10_000_000, total: 20_000_000 },
};
const screenPreset = () => SCREEN_PRESETS[settings.screenQuality] || SCREEN_PRESETS.high;

// Ochrona głosu: gdy łącze wysyłania nie wyrabia, w pierwszej kolejności tracą pakiety z dźwiękiem i rozmówcy
// „znikają”. Co kilka sekund sprawdzamy, czy odbiorcy gubią nasz głos albo opóźnienia rosną – jeśli tak, obraz
// ekranu dostaje mniejszą przepływność (mnożnik `factor`), a gdy łącze się uspokoi, jakość wraca.
const screenLoad = { factor: 1, bad: 0, good: 0, timer: null };

// Czysta funkcja decyzyjna (łatwa do przetestowania): zwraca 'down', 'up' albo null.
function nextScreenLoad(state, sample) {
  const bad = sample.loss > 0.05 || sample.rtt > 0.5; // >5% utraconych pakietów głosu albo RTT > 0,5 s
  state.bad = bad ? state.bad + 1 : 0;
  state.good = bad ? 0 : state.good + 1;
  if (state.bad >= 2 && state.factor > 0.25) {
    state.factor = Math.max(0.25, state.factor / 2);
    state.bad = 0;
    return 'down';
  }
  if (state.good >= 8 && state.factor < 1) {
    state.factor = Math.min(1, state.factor * 2);
    state.good = 0;
    return 'up';
  }
  return null;
}

async function checkShareHealth() {
  if (!voice.screen) return;
  const sample = { loss: 0, rtt: 0 };
  for (const peer of voice.peers.values()) {
    try {
      const stats = await peer.pc.getStats();
      stats.forEach((r) => {
        // raport odbiorcy o naszym głosie (mikrofonie): ile pakietów zgubił i jak długo trwa obieg
        if (r.type === 'remote-inbound-rtp' && r.kind === 'audio') {
          sample.loss = Math.max(sample.loss, r.fractionLost || 0);
          sample.rtt = Math.max(sample.rtt, r.roundTripTime || 0);
        }
      });
    } catch {
      /* połączenie właśnie się zamyka */
    }
  }
  const change = nextScreenLoad(screenLoad, sample);
  if (!change) return;
  voice.peers.forEach(applyScreenBitrate);
  if (change === 'down') {
    toast('Łącze jest przeciążone – obniżyłem jakość udostępniania, żeby głos nie przerywał.', true);
  }
}

function startShareHealth() {
  screenLoad.factor = 1;
  screenLoad.bad = 0;
  screenLoad.good = 0;
  clearInterval(screenLoad.timer);
  screenLoad.timer = setInterval(checkShareHealth, 4000);
}

function stopShareHealth() {
  clearInterval(screenLoad.timer);
  screenLoad.timer = null;
  screenLoad.factor = 1;
}

// Limit przepływności i liczby klatek dla jednego widza.
async function applyScreenBitrate(peer) {
  const preset = screenPreset();
  const viewers = Math.max(1, voice.peers.size);
  const base = Math.min(preset.perViewer, Math.floor(preset.total / viewers));
  const bps = Math.max(300_000, Math.floor(base * screenLoad.factor));
  const fps = screenLoad.factor <= 0.5 ? Math.min(preset.fps, 30) : preset.fps; // przy przeciążeniu mniej klatek
  const sender = peer.screen.video;
  if (!sender || !sender.track) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = bps;
    params.encodings[0].maxFramerate = fps;
    // obraz ma niższy priorytet w sieci niż głos
    params.encodings[0].priority = 'low';
    params.encodings[0].networkPriority = 'low';
    await sender.setParameters(params);
  } catch {
    /* przeglądarka nie pozwala – zostają ustawienia domyślne */
  }
}

// Mikrofon dostaje najwyższy priorytet w sieci – gdy łącze jest przeciążone, głos ma wygrać z obrazem.
async function prioritizeMic(peer) {
  const sender = peer.micSender;
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].priority = 'high';
    params.encodings[0].networkPriority = 'high';
    await sender.setParameters(params);
  } catch {
    /* przeglądarka nie pozwala – zostaje domyślnie */
  }
}

// Kodek VP9 daje wyraźnie lepszy obraz niż domyślny VP8 przy tej samej przepływności (zwłaszcza tekst i ostre krawędzie).
// Reszta kodeków zostaje na liście, więc przeglądarki bez VP9 nadal się dogadają.
function preferScreenCodecs(transceiver) {
  try {
    if (!transceiver.setCodecPreferences || !window.RTCRtpSender || !RTCRtpSender.getCapabilities) return;
    const rank = (c) => (/VP9/i.test(c.mimeType) ? 0 : /H264/i.test(c.mimeType) ? 1 : /VP8/i.test(c.mimeType) ? 2 : /AV1/i.test(c.mimeType) ? 3 : 4);
    const codecs = RTCRtpSender.getCapabilities('video').codecs.slice().sort((a, b) => rank(a) - rank(b));
    transceiver.setCodecPreferences(codecs);
  } catch {
    /* zostaje kodek domyślny */
  }
}

// Nadajniki ekranu (osobno obraz i dźwięk) tworzymy RAZ na połączenie i potem tylko podmieniamy w nich
// ścieżkę. Dzięki temu kolejne udostępnianie nie dokłada pozycji do opisu sesji (SDP) – wcześniej opis
// puchł z każdym cyklem aż do zawieszenia połączenia – i nie wymaga nowej negocjacji.
function setScreenTrack(peer, kind, track) {
  const sender = peer.screen[kind];
  if (sender) {
    sender.replaceTrack(track).catch((err) => console.warn('Nie udało się podmienić ścieżki ekranu:', err));
  } else if (track) {
    const transceiver = peer.pc.addTransceiver(track, { direction: 'sendonly', streams: [voice.screen] });
    peer.screen[kind] = transceiver.sender;
    if (kind === 'video') preferScreenCodecs(transceiver);
  }
}

function addScreenTracks(peer) {
  if (!voice.screen) return;
  for (const kind of ['video', 'audio']) {
    setScreenTrack(peer, kind, voice.screen.getTracks().find((t) => t.kind === kind) || null);
  }
}

// Podpis kafelka z własnym ekranem: rzeczywista rozdzielczość i liczba klatek, jaką dała przeglądarka.
function screenInfoLabel() {
  const track = voice.screen && voice.screen.getVideoTracks()[0];
  const s = track ? track.getSettings() : {};
  const parts = [];
  if (s.width && s.height) parts.push(`${s.width}×${s.height}`);
  if (s.frameRate) parts.push(`${Math.round(s.frameRate)} kl./s`);
  parts.push(voice.screen.getAudioTracks().length ? 'z dźwiękiem' : 'bez dźwięku');
  return `Twój ekran – ${parts.join(', ')}`;
}

// Zmiana jakości w trakcie udostępniania działa od razu (bez ponownego wybierania okna).
async function applyScreenQuality() {
  if (!voice.screen) return;
  const preset = screenPreset();
  const track = voice.screen.getVideoTracks()[0];
  if (!track) return;
  track.contentHint = settings.screenMode === 'detail' ? 'detail' : 'motion';
  try {
    await track.applyConstraints({
      frameRate: { ideal: preset.fps, max: preset.fps },
      width: { ideal: preset.width, max: preset.width },
      height: { ideal: preset.height, max: preset.height },
    });
  } catch {
    /* źródło nie pozwala na zmianę – zostaje obecne */
  }
  voice.peers.forEach(applyScreenBitrate);
  showScreen('me', voice.screen, screenInfoLabel());
}

async function startScreenShare() {
  if (!voice.active || voice.screen) return;
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return toast('Ta przeglądarka nie obsługuje udostępniania ekranu (na telefonach zwykle jest niedostępne).');
  }
  const preset = screenPreset();
  const wantAudio = settings.screenAudio !== 'off';
  const getDisplay = (constraints) => navigator.mediaDevices.getDisplayMedia(constraints);
  let stream;
  try {
    // Prosimy o wybraną rozdzielczość i liczbę klatek; dźwięk bez filtrów, bo to dźwięk systemu, nie mikrofon.
    // `selfBrowserSurface: 'exclude'` – karta z tym czatem w ogóle nie jest proponowana do udostępnienia
    // (jej dźwięk to rozmowa, czyli gotowe echo). `restrictOwnAudio` prosi o wycięcie dźwięku tej przeglądarki
    // z dźwięku systemu (nie każda wersja Chrome to potrafi – patrz niżej).
    stream = await getDisplay({
      video: {
        frameRate: { ideal: preset.fps, max: preset.fps },
        width: { ideal: preset.width, max: preset.width },
        height: { ideal: preset.height, max: preset.height },
      },
      audio: wantAudio
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true }
        : false,
      selfBrowserSurface: 'exclude',
    });
  } catch (err) {
    if (err.name === 'NotAllowedError') return; // anulowanie w oknie wyboru nie jest błędem
    try {
      stream = await getDisplay({ video: true, audio: wantAudio }); // przeglądarka nie zna tych ograniczeń – prosta wersja
    } catch (err2) {
      if (err2.name !== 'NotAllowedError') toast('Nie udało się rozpocząć udostępniania ekranu.');
      return;
    }
  }
  if (!voice.active) return stream.getTracks().forEach((t) => t.stop()); // w międzyczasie opuszczono kanał

  // Echo: dźwięk CAŁEGO ekranu zawiera to, co gra w przeglądarce, czyli głosy z rozmowy. Wróciłyby one do wszystkich
  // jako „dźwięk ekranu” – każdy słyszałby siebie z opóźnieniem i innych podwójnie. Dźwięk zostawiamy więc tylko
  // przy udostępnianiu karty (to wyłącznie dźwięk tej karty) albo gdy przeglądarka potwierdza wycięcie własnego dźwięku.
  const surface = stream.getVideoTracks()[0].getSettings().displaySurface;
  const [shareAudio] = stream.getAudioTracks();
  if (shareAudio) {
    const ownAudioExcluded = shareAudio.getSettings().restrictOwnAudio === true;
    if (surface !== 'browser' && !ownAudioExcluded) {
      stream.removeTrack(shareAudio);
      shareAudio.stop();
      toast(
        'Pominąłem dźwięk systemowy – zawiera głosy z rozmowy i wywołałby echo. Żeby udostępnić dźwięk, wybierz kartę przeglądarki zamiast całego ekranu.',
        true
      );
    }
  }

  voice.screen = stream;
  const videoTrack = stream.getVideoTracks()[0];
  // „motion” woli płynność (gry, wideo), „detail” – ostrość (tekst, kod, pulpit): to wpływa na to, co przeglądarka
  // poświęca, gdy brakuje przepływności.
  videoTrack.contentHint = settings.screenMode === 'detail' ? 'detail' : 'motion';
  // Użytkownik może zakończyć udostępnianie przyciskiem przeglądarki („Przestań udostępniać”).
  videoTrack.addEventListener('ended', stopScreenShare);
  voice.peers.forEach(addScreenTracks);
  voice.peers.forEach(applyScreenBitrate);
  startShareHealth();
  showScreen('me', stream, screenInfoLabel());
  applyVoiceState();
}

function stopScreenShare() {
  if (!voice.screen) return;
  const stream = voice.screen;
  voice.screen = null;
  // Nadajniki zostają (do ponownego użycia) – tylko przestają nadawać.
  voice.peers.forEach((peer) => {
    for (const kind of ['video', 'audio']) if (peer.screen[kind]) setScreenTrack(peer, kind, null);
  });
  stream.getTracks().forEach((t) => t.stop());
  stopShareHealth();
  removeScreen('me');
  applyVoiceState();
}

function closePeer(id) {
  const peer = voice.peers.get(id);
  if (!peer) return;
  peer.pc.onicecandidate = peer.pc.ontrack = peer.pc.onconnectionstatechange = null;
  peer.pc.onnegotiationneeded = peer.pc.onsignalingstatechange = null;
  clearTimeout(peer.offerWatch);
  clearTimeout(peer.disconnectTimer);
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
    screen: { video: null, audio: null }, // nasze nadajniki ekranu do tej osoby (używane wielokrotnie)
    screenStream: null, // strumień z ekranem, który ta osoba udostępnia nam
    offerWatch: null, // zegar pilnujący, czy ktoś odpowiedział na naszą ofertę
    offerRetries: 0,
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
      // Zabezpieczenie: jeśli nikt nie odpowie na ofertę (zgubiona po drodze), połączenie utknęłoby na zawsze.
      // Wycofujemy ofertę – przeglądarka sama zgłosi potrzebę negocjacji i wyśle ją ponownie.
      clearTimeout(peer.offerWatch);
      peer.offerWatch = setTimeout(async () => {
        if (pc.signalingState !== 'have-local-offer' || peer.offerRetries >= 5) return;
        peer.offerRetries += 1;
        console.warn('Brak odpowiedzi na ofertę głosową – ponawiam.');
        try {
          await pc.setLocalDescription({ type: 'rollback' });
        } catch {
          /* połączenie już się zmieniło */
        }
      }, 8000);
    } catch (err) {
      console.warn('Błąd negocjacji połączenia głosowego:', err);
    } finally {
      peer.makingOffer = false;
    }
  };
  pc.onsignalingstatechange = () => {
    if (pc.signalingState !== 'stable') return;
    clearTimeout(peer.offerWatch);
    peer.offerRetries = 0;
    if (!peer.micPrioritized) {
      peer.micPrioritized = true;
      prioritizeMic(peer); // parametry nadajnika da się ustawić dopiero po pierwszej wymianie opisów
    }
    if (peer.screen.video) applyScreenBitrate(peer);
  };

  voice.stream.getTracks().forEach((track) => {
    peer.micSender = pc.addTrack(track, voice.stream);
  });

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('voice:signal', { to: id, data: { candidate: e.candidate.toJSON() } });
  };
  pc.ontrack = (e) => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    // Pierwszy dźwięk od tej osoby to mikrofon; wszystko inne (obraz i dźwięk ekranu) trafia do kafelka.
    const isMic = e.track.kind === 'audio' && (peer.micStreamId === null || peer.micStreamId === stream.id);
    if (!isMic) {
      peer.screenStream = stream; // kafelek pokażemy, gdy serwer potwierdzi, że ta osoba nadaje (syncScreen)
      syncScreen(id);
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
    clearTimeout(peer.disconnectTimer);
    if (pc.connectionState === 'connected') {
      peer.failedToastShown = false;
    } else if (pc.connectionState === 'failed') {
      // Połączenie padło (np. łącze było chwilowo przeciążone) – próbujemy je naprawić zamiast zostawiać ciszę.
      if (!restartPeerIce(peer, 'połączenie padło') && !peer.failedToastShown) {
        peer.failedToastShown = true;
        toast('Nie udało się połączyć głosowo z jedną z osób (sieć może wymagać serwera TURN).');
      }
    } else if (pc.connectionState === 'disconnected') {
      // „Disconnected” bywa chwilowe; jeśli trwa dłużej niż kilka sekund, odświeżamy połączenie.
      peer.disconnectTimer = setTimeout(() => {
        if (pc.connectionState === 'disconnected') restartPeerIce(peer, 'przerwane połączenie');
      }, 4000);
    }
  };

  voice.peers.set(id, peer);
  return peer;
}

// Restart ICE szuka nowej ścieżki sieciowej bez zrywania rozmowy (wymaga nowej oferty – robi to negocjacja).
// Nie częściej niż 4 razy na minutę, żeby nie wpaść w pętlę przy trwałej awarii.
function restartPeerIce(peer, reason) {
  const now = Date.now();
  peer.iceRestartLog = (peer.iceRestartLog || []).filter((t) => now - t < 60000);
  if (!peer.negotiationEnabled || peer.iceRestartLog.length >= 4) return false;
  peer.iceRestartLog.push(now);
  console.warn(`Restart połączenia głosowego (${reason}).`);
  try {
    peer.pc.restartIce();
    return true;
  } catch {
    return false;
  }
}

// Straż: jeśli od rozmówcy przez kilka sekund nie dochodzą żadne pakiety głosu (a połączenie wygląda na żywe),
// odświeżamy połączenie. Mikrofon zawsze wysyła pakiety – także wyciszony (cisza) – więc brak ruchu to awaria.
const VOICE_WATCH_MS = 3000;
let voiceStallLimit = 3; // tyle kolejnych kontroli bez ruchu = awaria (domyślnie ok. 9 s)
let voiceWatchTimer = null;

async function checkVoiceHealth() {
  for (const peer of voice.peers.values()) {
    const micTrack = peer.audio && peer.audio.srcObject && peer.audio.srcObject.getAudioTracks()[0];
    if (!micTrack || peer.pc.connectionState !== 'connected') {
      peer.micStall = 0;
      continue;
    }
    try {
      let bytes = null;
      (await peer.pc.getStats(micTrack)).forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') bytes = r.bytesReceived;
      });
      if (bytes === null) continue;
      peer.micStall = peer.lastMicBytes !== undefined && bytes <= peer.lastMicBytes ? (peer.micStall || 0) + 1 : 0;
      peer.lastMicBytes = bytes;
      if (peer.micStall >= voiceStallLimit) {
        peer.micStall = 0;
        restartPeerIce(peer, 'brak dźwięku od rozmówcy');
      }
    } catch {
      /* połączenie właśnie się zamyka */
    }
  }
}

function startVoiceWatch() {
  clearInterval(voiceWatchTimer);
  voiceWatchTimer = setInterval(checkVoiceHealth, VOICE_WATCH_MS);
}

function stopVoiceWatch() {
  clearInterval(voiceWatchTimer);
  voiceWatchTimer = null;
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

// Dołącza do kanału głosowego grupy (domyślnie oglądanej). Będąc na kanale innej grupy – przenosi się.
async function joinVoice(groupId = myCurrentGroup()?.id) {
  if (voice.joining || !myNick) return;
  if (!groupId || !groups.some((g) => g.id === groupId)) return toast('Najpierw otwórz grupę, do której kanału głosowego chcesz dołączyć.');
  if (voice.active && voice.groupId === groupId) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    return toast('Czat głosowy wymaga połączenia HTTPS i nowszej przeglądarki.');
  }
  if (voice.active) leaveVoice(); // przenosiny do kanału innej grupy

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

  socket.timeout(10000).emit('voice:join', groupId, (err, res) => {
    voice.joining = false;
    if (err || !res || !res.ok) {
      stopLocalStream();
      return toast((res && res.error) || 'Nie udało się dołączyć do kanału głosowego.');
    }
    voice.active = true;
    voice.groupId = groupId;
    voice.users = voiceLists.get(groupId) || [];
    voice.muted = false;
    voice.deafened = false;
    watchSpeaking('me', voice.stream);
    startVoiceWatch();
    res.peers.forEach((id) => callPeer(id).catch((e) => console.warn('Błąd połączenia głosowego:', e)));
    updateVoiceUI();
  });
}

function leaveVoice(notify = true) {
  if (!voice.active && !voice.stream) return;
  if (notify && voice.active && socket.connected) socket.emit('voice:leave');
  stopVoiceWatch();
  if (voice.screen) {
    voice.screen.getTracks().forEach((t) => t.stop());
    voice.screen = null;
    stopShareHealth();
    removeScreen('me');
  }
  Array.from(voice.peers.keys()).forEach(closePeer);
  unwatchSpeaking('me');
  stopLocalStream();
  voice.active = false;
  voice.groupId = null;
  voice.users = [];
  voice.muted = false;
  voice.deafened = false;
  document.querySelectorAll('.speaking').forEach((n) => n.classList.remove('speaking'));
  updateVoiceUI();
}

socket.on('voice:users', ({ groupId, users: list }) => {
  voiceLists.set(groupId, list);
  if (!voice.active || voice.groupId !== groupId) return renderVoiceUsers(); // to nie nasz kanał – tylko odśwież panel
  const previous = voice.users.length;
  voice.users = list;
  if (voice.active) {
    const ids = new Set(list.map((u) => u.id));
    Array.from(voice.peers.keys()).forEach((id) => {
      if (!ids.has(id)) closePeer(id);
    });
    // Pokaż lub zamknij kafelki ekranów zgodnie z tym, kto teraz nadaje.
    list.forEach((u) => {
      if (u.id !== socket.id) syncScreen(u.id);
    });
    if (list.length > previous) beep([660, 880]);
    else if (list.length < previous) beep([520, 380]);
  }
  renderVoiceUsers();
});

$('voice-channel').addEventListener('click', () => joinVoice());
$('voice-btn').addEventListener('click', () => {
  const viewed = myCurrentGroup();
  if (voice.active && viewed && voice.groupId === viewed.id) leaveVoice();
  else joinVoice();
});
$('voice-leave').addEventListener('click', () => leaveVoice());
$('voice-screen').addEventListener('click', () => (voice.screen ? stopScreenShare() : startScreenShare()));

// Jakość udostępniania ekranu: zapis w ustawieniach i natychmiastowe zastosowanie, jeśli akurat nadajesz.
$('screen-quality').addEventListener('change', (e) => {
  settings.screenQuality = e.target.value;
  store.set('mychat.settings', settings);
  applyScreenQuality();
});
$('screen-mode').addEventListener('change', (e) => {
  settings.screenMode = e.target.value;
  store.set('mychat.settings', settings);
  applyScreenQuality();
});
$('screen-audio').addEventListener('change', (e) => {
  settings.screenAudio = e.target.value; // zadziała przy następnym udostępnianiu (dźwięk wybiera się przy starcie)
  store.set('mychat.settings', settings);
});
$('voice-screen-settings').addEventListener('click', () => openSettings('chat'));
// Na urządzeniach bez udostępniania ekranu (np. telefony) ukrywamy przycisk – oglądanie cudzego ekranu działa.
if (!navigator.mediaDevices?.getDisplayMedia) {
  $('voice-screen').classList.add('hidden');
  $('voice-screen-settings').classList.add('hidden');
}
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
  if (!currentChannel || m.channel !== currentChannel) return;
  if (historyLoading) pendingLive.push(m);
  else handleLive(m);
});
// Komunikaty systemowe (np. „ktoś dołączył do grupy”) pokazujemy tylko w czacie grupy, której dotyczą.
socket.on('system', (m) => {
  if (!m.channel || m.channel !== currentChannel) return;
  addSystem(m);
});

// Nowa wiadomość na kanale, którego akurat nie oglądasz – zapalamy kropkę przy jego nazwie.
socket.on('activity', ({ channel, mention }) => {
  if (channel === currentChannel) return;
  if (mention) {
    mentionCounts.set(channel, (mentionCounts.get(channel) || 0) + 1);
    beep([880, 1175]); // wzmianka zasługuje na wyraźniejszy dźwięk niż zwykła wiadomość
  }
  unreadChannels.add(channel);
  renderChannels();
});

// ---------- Kanały tekstowe: lista, przełączanie ----------
const groupChannelsOf = (g) => (Array.isArray(g.channels) && g.channels.length ? g.channels : [{ id: g.channel, name: 'ogólny', isDefault: true }]);

function groupByChannel(id) {
  return isGroupChannel(id) ? groups.find((g) => groupChannelsOf(g).some((c) => c.id === id)) || null : null;
}

// Uprawnienia w oglądanej grupie.
const hasGroupPerm = (group, perm) => Boolean(group) && Array.isArray(group.perms) && group.perms.includes(perm);
const myCurrentGroup = () => groupByChannel(currentChannel);
const canPostHere = () => hasGroupPerm(myCurrentGroup(), 'send');

function channelById(id) {
  const group = groupByChannel(id);
  const entry = group && groupChannelsOf(group).find((c) => c.id === id);
  return entry ? { id, name: entry.name } : null;
}

// Obrazek grupy (albo pierwsza litera nazwy na kolorowym tle, gdy go nie ma).
function applyGroupIcon(node, g) {
  node.classList.toggle('has-icon', Boolean(g.icon));
  if (g.icon && isSafeImageSrc(g.icon)) {
    node.style.background = `center / cover no-repeat url("${g.icon}")`;
    node.textContent = '';
  } else {
    node.style.background = colorFor(g.name);
    node.textContent = (g.name.trim()[0] || '?').toUpperCase();
  }
}

function renderChannels() {
  const group = groupByChannel(currentChannel);
  const current = channelById(currentChannel);
  const connecting = !serverSynced; // lista grup pochodzi wyłącznie z serwera – bez niego nic nie pokazujemy
  const empty = groups.length === 0 || connecting;

  // Bez żadnej grupy nie ma czatu – pokazujemy ekran powitalny z prośbą o dołączenie do grupy lub założenie własnej.
  chatScreen.classList.toggle('app--empty', empty);
  $('empty-state').classList.toggle('hidden', !empty || connecting);
  $('connecting-state').classList.toggle('hidden', !connecting);
  document.querySelector('.main__body').classList.toggle('hidden', empty);
  $('channel-select').classList.toggle('hidden', empty);
  $('voice-btn').classList.toggle('hidden', empty);

  // Lewy panel pokazuje kanały oglądanej grupy i jej kanał głosowy.
  $('channels-title').textContent = group ? group.name : 'MyChat';
  const icon = $('channels-icon');
  icon.classList.toggle('hidden', !group);
  if (group) applyGroupIcon(icon, group);
  $('channels-category').textContent = 'KANAŁY TEKSTOWE';
  $('voice-block').classList.toggle('hidden', !group);
  $('group-gear').classList.toggle('hidden', !group);
  $('channel-add').classList.toggle('hidden', !hasGroupPerm(group, 'manageChannels'));

  $('channel-list').replaceChildren(
    ...(group ? groupChannelsOf(group) : []).map((c) => {
      const active = c.id === currentChannel;
      const unread = unreadChannels.has(c.id) && !active;
      const item = el('button', 'channel' + (active ? ' channel--active' : '') + (unread ? ' channel--unread' : ''));
      item.type = 'button';
      item.dataset.channel = c.id;
      item.appendChild(el('span', 'hash', '#'));
      item.appendChild(document.createTextNode(` ${c.name}`));
      const mentions = active ? 0 : mentionCounts.get(c.id) || 0;
      if (mentions) item.appendChild(el('span', 'channel__mentions', String(mentions)));
      else if (unread) item.appendChild(el('span', 'channel__dot'));
      item.addEventListener('click', () => switchChannel(c.id));
      return item;
    })
  );

  // Lista kanałów na telefonie (bez panelu bocznego): wszystkie kanały wszystkich Twoich grup.
  const select = $('channel-select');
  const mark = (id) => (unreadChannels.has(id) && id !== currentChannel ? ' •' : '');
  select.replaceChildren(
    ...groups.map((g) => {
      const optgroup = el('optgroup');
      optgroup.label = g.name;
      groupChannelsOf(g).forEach((c) => {
        const opt = el('option', '', `# ${c.name}${mark(c.id)}`);
        opt.value = c.id;
        optgroup.appendChild(opt);
      });
      return optgroup;
    })
  );
  if (currentChannel) select.value = currentChannel;

  $('channel-title').textContent = group && current ? `${group.name} › ${current.name}` : 'MyChat';
  const canPost = canPostHere();
  messageInput.placeholder = !current
    ? 'Dołącz do grupy, żeby pisać'
    : !canPost
      ? 'Nie masz uprawnienia do pisania w tej grupie'
      : `Napisz wiadomość w #${current.name} (${group.name})`;
  messageInput.disabled = !canPost;
  $('message-form').classList.toggle('composer--locked', !canPost);
  renderRail();
  renderVoiceUsers();
}

// ---------- Grupy: pasek po lewej ----------
function renderRail() {
  $('rail-groups').replaceChildren(
    ...groups.map((g) => {
      const ids = groupChannelsOf(g).map((c) => c.id);
      const active = ids.includes(currentChannel);
      const btn = el('button', 'rail__icon' + (active ? ' is-active' : ''));
      applyGroupIcon(btn, g);
      btn.type = 'button';
      btn.title = g.name;
      btn.setAttribute('aria-label', `Grupa ${g.name}`);
      const mentions = ids.reduce((n, id) => n + (id === currentChannel ? 0 : mentionCounts.get(id) || 0), 0);
      if (mentions) btn.appendChild(el('span', 'rail__badge', String(mentions)));
      else if (ids.some((id) => id !== currentChannel && unreadChannels.has(id))) btn.appendChild(el('span', 'rail__dot'));
      btn.addEventListener('click', () => {
        const last = lastGroupChannel.get(g.id);
        switchChannel(last && ids.includes(last) ? last : g.channel);
      });
      return btn;
    })
  );
}

$('rail-add').addEventListener('click', () => openGroups());
$('groups-btn').addEventListener('click', () => openGroups());
$('empty-join').addEventListener('click', () => openGroups('code'));
$('empty-create').addEventListener('click', () => openGroups('name'));

$('channel-select').addEventListener('change', (e) => switchChannel(e.target.value));

// Przestawia widok na inny kanał (bez pytania serwera – on sam albo już to zrobił, albo zaraz zrobi).
// `null` = żaden kanał (brak grup).
function showChannelView(id) {
  currentChannel = id;
  renderPartyBar();
  const viewedGroup = groupByChannel(id);
  if (viewedGroup) lastGroupChannel.set(viewedGroup.id, id);
  historyLoading = Boolean(id); // nowe wiadomości czekają, aż przyjdzie historia tego kanału
  pendingLive.length = 0;
  if (id) {
    unreadChannels.delete(id);
    mentionCounts.delete(id);
  }
  clearReply(); // odpowiedź dotyczy wiadomości z poprzedniego kanału
  typingUsers.clear();
  renderTyping();
  messagesEl.replaceChildren();
  lastNick = null;
  lastDay = null;
  archiveLimit = 300;
  store.set('mychat.channel', { id });
  renderChannels();
  closePopups();
  if (groupByChannel(id)) {
    if (groupMembersFor !== groupByChannel(id).id) groupMembers = []; // nie pokazuj członków poprzedniej grupy
    renderMembersPanel();
    loadGroupMembers();
  } else {
    groupMembers = [];
    groupMembersFor = null;
    renderMembersPanel();
  }
}

function switchChannel(id) {
  if (id === currentChannel || !groupByChannel(id)) return renderChannels();
  if (!socket.connected) {
    renderChannels();
    return toast('Brak połączenia z serwerem.');
  }

  const previous = currentChannel;
  showChannelView(id);

  socket.timeout(10000).emit('switchChannel', { channel: id }, (err, res) => {
    if (!err && res && res.ok) return;
    // Nie udało się – wracamy na poprzedni kanał (jeśli jakiś był).
    toast((res && res.error) || 'Nie udało się zmienić kanału.');
    historyLoading = false;
    if (currentChannel !== id) return;
    if (previous && groupByChannel(previous)) switchChannel(previous);
    else ensureChannel();
  });
}

// Gdy nie oglądasz żadnego (istniejącego) kanału: wejdź do pierwszej swojej grupy albo pokaż ekran powitalny.
function ensureChannel() {
  if (currentChannel && groupByChannel(currentChannel)) return;
  const first = groups[0];
  if (first) switchChannel(lastGroupChannel.get(first.id) || first.channel);
  else showChannelView(null);
}

// Usunięta wiadomość znika wszędzie: z ekranu, z pamięci sesji i z archiwum lokalnego (razem z plikiem).
async function applyDeletions(ids) {
  ids.forEach((id) => {
    removeMessageNode(id);
    sessionLog.delete(id);
    localFileIds.delete(id);
    // Odpowiedzi na usuniętą wiadomość przestają ją cytować.
    messagesEl.querySelectorAll(`.msg__reply[data-reply-id="${CSS.escape(id)}"]`).forEach(markReplyMissing);
    if (replyingTo && replyingTo.id === id) clearReply();
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
socket.on('users', (list) => {
  onlineUsers = list;
  renderMembersPanel();
});

// ---------- Grupy prywatne: okno zarządzania i zdarzenia z serwera ----------
const groupsModal = $('groups-modal');
const removedByMe = new Set(); // grupy, które właśnie opuszczam/usuwam – bez dodatkowego powiadomienia

function openGroups(focus = 'code') {
  groupsModal.classList.remove('hidden');
  renderGroupList();
  $(focus === 'name' ? 'group-name' : 'group-code').focus();
}

function closeGroups() {
  groupsModal.classList.add('hidden');
}

function setGroups(list) {
  groups = Array.isArray(list) ? list : [];
  // Gdyby grupa lub kanał, który oglądasz, zniknął bez zdarzenia usunięcia – wróć do tej grupy albo do innej.
  if (currentChannel && !groupByChannel(currentChannel)) {
    const owner = groups.find((g) => currentChannel.startsWith(`g_${g.id}`));
    if (owner) showChannelView(owner.channel);
    else ensureChannel();
  } else if (!currentChannel) {
    ensureChannel();
  }
  renderChannels();
  renderGroupList();
  if (groupByChannel(currentChannel)) renderMembersPanel();
  renderGroupSettings();
}

function upsertGroup(info) {
  setGroups(groups.some((g) => g.id === info.id) ? groups.map((g) => (g.id === info.id ? info : g)) : [...groups, info]);
}

function copyText(text) {
  const fallback = () => {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
    } catch {
      /* ignorujemy */
    }
    area.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(fallback);
  else fallback();
}

function groupAction(event, arg, done) {
  socket.timeout(10000).emit(event, arg, (err, res) => {
    if (err || !res || !res.ok) return toast((res && res.error) || 'Nie udało się. Spróbuj ponownie.');
    done(res);
  });
}

function renderGroupList() {
  const list = $('group-list');
  if (!list) return;
  if (!groups.length) {
    list.replaceChildren(el('div', 'groups__empty', 'Nie należysz jeszcze do żadnej grupy.'));
    return;
  }
  list.replaceChildren(
    ...groups.map((g) => {
      const card = el('div', 'group-card');
      const head = el('div', 'group-card__head');
      const icon = el('div', 'group-card__icon');
      applyGroupIcon(icon, g);
      const info = el('div', 'group-card__info');
      const name = el('div', 'group-card__name', g.name);
      if (g.isOwner) name.appendChild(el('span', 'group-card__crown', 'TWÓRCA'));
      info.append(name, el('div', 'group-card__meta', `${g.memberCount} / ${g.maxMembers} członków`));
      head.append(icon, info);
      card.appendChild(head);

      // Kod widzi i generuje twórca oraz osoby z uprawnieniem „Kody dostępu” (serwer nie wysyła go pozostałym).
      if (g.code) {
        const box = el('div', 'group-card__code');
        box.appendChild(el('div', 'group-card__code-label', 'JEDNORAZOWY KOD DOSTĘPU'));
        box.appendChild(el('span', 'group-card__code-value', g.code));
        const copy = iconButton('copy', 'Kopiuj kod', () => {
          copyText(g.code);
          toast('Kod skopiowany', true);
        });
        const renew = iconButton('refresh', 'Nowy kod – poprzedni przestanie działać', () =>
          groupAction('group:code', g.id, () => toast('Wygenerowano nowy kod', true))
        );
        box.append(copy, renew);
        card.appendChild(box);
      }

      const actions = el('div', 'group-card__actions');
      const isOpen = g.channel === currentChannel;
      actions.appendChild(
        iconButton(
          'chat',
          isOpen ? 'Ta grupa jest już otwarta' : 'Otwórz grupę',
          () => {
            closeGroups();
            switchChannel(g.channel);
          },
          { variant: 'btn-primary', disabled: isOpen }
        )
      );
      actions.appendChild(iconButton('gear', 'Ustawienia grupy', () => openGroupSettings(g.id)));

      actions.appendChild(leaveOrDeleteButton(g));
      card.appendChild(actions);
      return card;
    })
  );
}

// Przycisk z samą ikoną (podpowiedź i etykieta dla czytników ekranu w `label`).
function iconButton(name, label, onClick, { variant = 'btn-secondary', danger = false, disabled = false } = {}) {
  const b = iconNode('button', `${variant} btn-sm btn-iconly${danger ? ' btn-danger' : ''}`, name);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

function leaveOrDeleteButton(g) {
  if (g.isOwner) {
    return iconButton(
      'trash',
      'Usuń grupę',
      () => {
        if (!confirm(`Usunąć grupę „${g.name}”? Wszyscy członkowie zostaną z niej usunięci, a cała historia czatu przepadnie.`)) return;
        removedByMe.add(g.id);
        groupAction('group:delete', g.id, () => toast(`Usunięto grupę ${g.name}`, true));
      },
      { danger: true }
    );
  }
  return iconButton('logout', 'Opuść grupę', () => {
    if (!confirm(`Opuścić grupę „${g.name}”? Aby wrócić, będziesz potrzebować nowego kodu od twórcy.`)) return;
    removedByMe.add(g.id);
    groupAction('group:leave', g.id, () => toast(`Opuszczono grupę ${g.name}`, true));
  });
}

// ---------- Ustawienia grupy: przegląd, kanały, role, członkowie ----------
const PERM_LABELS = {
  admin: ['Administrator', 'Wszystkie uprawnienia (poza usunięciem grupy). Nadawaj ostrożnie.'],
  send: ['Pisanie wiadomości', 'Wysyłanie wiadomości, GIFów i plików.'],
  manageMessages: ['Zarządzanie wiadomościami', 'Usuwanie cudzych wiadomości.'],
  manageChannels: ['Zarządzanie kanałami', 'Tworzenie, zmiana nazwy i usuwanie kanałów.'],
  manageRoles: ['Zarządzanie rolami', 'Tworzenie ról i nadawanie ich osobom stojącym niżej w hierarchii.'],
  kick: ['Wyrzucanie członków', 'Usuwanie z grupy osób stojących niżej w hierarchii.'],
  invite: ['Kody dostępu', 'Podgląd i generowanie jednorazowego kodu do grupy.'],
  manageGroup: ['Zmiana nazwy grupy', 'Edycja nazwy grupy.'],
};
const PERM_ORDER = ['admin', 'send', 'manageMessages', 'manageChannels', 'manageRoles', 'kick', 'invite', 'manageGroup'];

const gsetModal = $('gset-modal');
const GSET_PANES = {
  overview: { title: 'Przegląd grupy', lead: 'Nazwa, obrazek i kod dostępu, którym zaprosisz nowe osoby.' },
  channels: { title: 'Kanały', lead: 'Kanały tekstowe tej grupy – każdy ma osobną historię.' },
  members: { title: 'Członkowie', lead: 'Osoby w grupie. Ikona etykiety nadaje im role, a druga ikona wyrzuca z grupy.' },
  roles: { title: 'Role', lead: 'Role dają uprawnienia i kolor. Nadajesz je w zakładce Członkowie.' },
};
const gset = { groupId: null, tab: 'overview', roleId: 'everyone', openMember: null, members: [], membersFor: null };

const gsetGroup = () => groups.find((g) => g.id === gset.groupId) || null;
const roleIdx = (g, id) => g.roles.findIndex((r) => r.id === id);
// Pozycja osoby w hierarchii: twórca -1, bez ról – nieskończoność (im mniej, tym wyżej)
const memberRank = (g, m) => {
  if (m.isOwner) return -1;
  const idx = (m.roles || []).map((id) => roleIdx(g, id)).filter((i) => i !== -1);
  return idx.length ? Math.min(...idx) : Infinity;
};

function openGroupSettings(groupId, tab = 'overview') {
  gset.groupId = groupId;
  gset.tab = tab;
  gset.roleId = 'everyone';
  gset.openMember = null;
  gset.membersFor = null;
  closeGroups();
  gsetModal.classList.remove('hidden');
  renderGroupSettings();
}

function closeGroupSettings() {
  gsetModal.classList.add('hidden');
  gset.groupId = null;
}

function fetchGsetMembers() {
  const g = gsetGroup();
  if (!g) return;
  const wanted = g.id;
  socket.timeout(10000).emit('group:members', wanted, (err, res) => {
    if (err || !res || !res.ok || gset.groupId !== wanted) return;
    gset.members = res.members;
    gset.membersFor = wanted;
    renderGroupSettings();
  });
}

function permCheckboxes(g, current, { editable, allowAdmin = true }) {
  const wrap = el('div', 'gset__perms');
  PERM_ORDER.filter((p) => allowAdmin || p !== 'admin').forEach((p) => {
    const row = el('label', 'gset__perm');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = p;
    box.checked = current.includes(p);
    // Nadawać można tylko uprawnienia, które sam się ma (twórca i administrator mają wszystkie).
    box.disabled = !editable || !g.perms.includes(p);
    const text = el('span', 'gset__perm-text');
    text.append(el('span', 'gset__perm-name', PERM_LABELS[p][0]), el('span', 'gset__perm-desc', PERM_LABELS[p][1]));
    row.append(box, text);
    wrap.appendChild(row);
  });
  return wrap;
}

function gsetSection(title) {
  const s = el('section', 'gset__section');
  if (title) s.appendChild(el('div', 'section-title', title));
  return s;
}

function gsetButton(label, cls, onClick, { disabled = false, title = '' } = {}) {
  const b = el('button', cls);
  if (typeof label === 'string') b.textContent = label;
  else b.appendChild(label); // ikona (węzeł SVG)
  b.type = 'button';
  b.disabled = disabled;
  if (title) {
    b.title = title;
    b.setAttribute('aria-label', title);
  }
  b.addEventListener('click', onClick);
  return b;
}

function gsetOverview(g, body) {
  // Obrazek grupy: widać go na pasku po lewej, w liście grup i nad kanałami (zmienia ten, kto może zmieniać nazwę grupy).
  const iconSec = gsetSection('Obrazek grupy');
  const iconRow = el('div', 'gset__iconrow');
  const preview = el('div', 'group-card__icon gset__icon');
  applyGroupIcon(preview, g);
  const canIcon = g.perms.includes('manageGroup');
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = 'image/*';
  file.hidden = true;
  file.addEventListener('change', async () => {
    const picked = file.files[0];
    file.value = '';
    if (!picked) return;
    try {
      const icon = await fileToAvatar(picked); // jak avatar: zmniejszony do 128×128, a GIF zostaje animowany
      groupAction('group:icon', { groupId: g.id, icon }, () => toast('Zmieniono obrazek grupy', true));
    } catch (err) {
      toast(err.message);
    }
  });
  iconRow.append(
    preview,
    file,
    gsetButton(icon('image'), 'btn-secondary btn-sm btn-iconly', () => file.click(), { disabled: !canIcon, title: 'Zmień obrazek grupy' }),
    gsetButton(icon('trash'), 'btn-secondary btn-sm btn-iconly', () => groupAction('group:icon', { groupId: g.id, icon: null }, () => toast('Usunięto obrazek', true)), {
      disabled: !canIcon || !g.icon,
      title: 'Usuń obrazek grupy',
    })
  );
  iconSec.appendChild(iconRow);
  iconSec.appendChild(el('div', 'groups__hint', 'Zwykłe obrazy są kadrowane do kwadratu; animowany GIF może mieć do 600 KB.'));
  body.appendChild(iconSec);

  const nameSec = gsetSection('Nazwa grupy');
  const row = el('div', 'groups__row');
  const input = el('input', 'field');
  input.value = g.name;
  input.maxLength = 30;
  input.disabled = !g.perms.includes('manageGroup');
  row.append(
    input,
    gsetButton(icon('check'), 'btn-primary btn-sm btn-iconly', () => groupAction('group:rename', { groupId: g.id, name: input.value }, () => toast('Zapisano nazwę', true)), {
      disabled: input.disabled,
      title: 'Zapisz nazwę',
    })
  );
  nameSec.appendChild(row);
  body.appendChild(nameSec);

  const permSec = gsetSection('Twoje uprawnienia');
  const mine = g.isOwner ? ['Twórca grupy – masz wszystkie uprawnienia'] : PERM_ORDER.filter((p) => g.perms.includes(p)).map((p) => PERM_LABELS[p][0]);
  const chips = el('div', 'gset__chips');
  (mine.length ? mine : ['brak specjalnych uprawnień']).forEach((t) => chips.appendChild(el('span', 'gset__chip', t)));
  permSec.appendChild(chips);
  body.appendChild(permSec);

  if (g.code) {
    const codeSec = gsetSection('Jednorazowy kod dostępu');
    const box = el('div', 'group-card__code');
    box.appendChild(el('span', 'group-card__code-value', g.code));
    box.append(
      gsetButton(icon('copy'), 'btn-secondary btn-sm btn-iconly', () => {
        copyText(g.code);
        toast('Kod skopiowany', true);
      }, { title: 'Kopiuj kod' }),
      gsetButton(icon('refresh'), 'btn-secondary btn-sm btn-iconly', () => groupAction('group:code', g.id, () => toast('Wygenerowano nowy kod', true)), {
        title: 'Nowy kod – poprzedni przestanie działać',
      })
    );
    codeSec.appendChild(box);
    codeSec.appendChild(el('div', 'groups__hint', 'Po użyciu kod wygasa, a w jego miejsce powstaje następny.'));
    body.appendChild(codeSec);
  }

  const leaveSec = gsetSection(g.isOwner ? 'Usuń grupę' : 'Opuść grupę');
  leaveSec.appendChild(
    el(
      'p',
      'settings-note',
      g.isOwner
        ? 'Wszyscy członkowie zostaną usunięci, a cała historia czatu przepadnie. Tego nie da się cofnąć.'
        : 'Aby wrócić, będziesz potrzebować nowego kodu od twórcy grupy.'
    )
  );
  leaveSec.appendChild(leaveOrDeleteButton(g));
  body.appendChild(leaveSec);
}

function gsetChannels(g, body) {
  const canManage = g.perms.includes('manageChannels');
  const listSec = gsetSection(`Kanały tekstowe — ${g.channels.length}`);
  g.channels.forEach((c) => {
    const row = el('div', 'gset__row');
    row.appendChild(el('span', 'hash', '#'));
    const input = el('input', 'field');
    input.value = c.name;
    input.maxLength = 24;
    input.disabled = !canManage;
    row.appendChild(input);
    if (canManage) {
      row.appendChild(
        gsetButton(icon('check'), 'btn-secondary btn-sm btn-iconly', () =>
          groupAction('group:channel:rename', { groupId: g.id, channel: c.id, name: input.value }, () => toast('Zapisano nazwę kanału', true)),
          { title: 'Zapisz nazwę kanału' }
        )
      );
      if (!c.isDefault) {
        row.appendChild(
          gsetButton(icon('trash'), 'btn-secondary btn-sm btn-iconly btn-danger', () => {
            if (!confirm(`Usunąć kanał #${c.name}? Wszystkie jego wiadomości i pliki przepadną.`)) return;
            groupAction('group:channel:delete', { groupId: g.id, channel: c.id }, () => toast('Usunięto kanał', true));
          }, { title: 'Usuń kanał' })
        );
      }
    } else if (c.isDefault) {
      row.appendChild(el('span', 'gset__tag', 'główny'));
    }
    listSec.appendChild(row);
  });
  body.appendChild(listSec);

  if (canManage) {
    const addSec = gsetSection('Nowy kanał');
    const row = el('form', 'groups__row');
    const input = el('input', 'field');
    input.id = 'gset-new-channel';
    input.placeholder = 'nazwa-kanału';
    input.maxLength = 24;
    row.append(input, gsetButton(icon('plus'), 'btn-primary btn-sm btn-iconly', () => {}, { title: 'Dodaj kanał' }));
    row.lastChild.type = 'submit';
    row.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      groupAction('group:channel:create', { groupId: g.id, name: input.value }, (res) => {
        toast('Dodano kanał', true);
        input.value = '';
        lastGroupChannel.set(g.id, res.channel);
      });
    });
    addSec.appendChild(row);
    addSec.appendChild(el('div', 'groups__hint', `Do ${15} kanałów w grupie. Każdy członek widzi wszystkie kanały.`));
    body.appendChild(addSec);
  } else {
    body.appendChild(el('div', 'groups__hint', 'Nie masz uprawnienia do zarządzania kanałami.'));
  }
}

function gsetRoles(g, body) {
  const canManage = g.perms.includes('manageRoles');
  const layout = el('div', 'gset__roles');

  // lewa kolumna: lista ról (od najwyższej)
  const list = el('div', 'gset__rolelist');
  const item = (id, label, color, count, idx) => {
    const row = el('div', 'gset__roleitem' + (gset.roleId === id ? ' is-active' : ''));
    const dot = el('span', 'gset__dot');
    dot.style.background = color || 'var(--text-muted)';
    row.append(dot, el('span', 'gset__rolename', label), el('span', 'gset__rolecount', String(count)));
    row.addEventListener('click', () => {
      gset.roleId = id;
      renderGroupSettings();
    });
    if (idx !== null && canManage && g.rank < idx) {
      const mover = el('span', 'gset__movers');
      const up = gsetButton(icon('chevron-up'), 'gset__mv', (e) => {
        e.stopPropagation();
        groupAction('group:role:move', { groupId: g.id, roleId: id, dir: -1 }, () => {});
      }, { disabled: idx === 0 || g.rank >= idx - 1, title: 'Wyżej' });
      const down = gsetButton(icon('chevron-down'), 'gset__mv', (e) => {
        e.stopPropagation();
        groupAction('group:role:move', { groupId: g.id, roleId: id, dir: 1 }, () => {});
      }, { disabled: idx === g.roles.length - 1, title: 'Niżej' });
      mover.append(up, down);
      row.appendChild(mover);
    }
    return row;
  };
  g.roles.forEach((r, i) => list.appendChild(item(r.id, r.name, r.color, r.memberCount, i)));
  list.appendChild(item('everyone', '@everyone', null, g.memberCount, null));
  if (canManage) {
    list.appendChild(
      gsetButton(textWithIcon('Nowa rola', 'plus'), 'btn-secondary btn-sm gset__newrole', () =>
        groupAction('group:role:create', { groupId: g.id, name: 'nowa rola', perms: [] }, (res) => {
          gset.roleId = res.roleId; // zdarzenie z listą grup mogło przyjść wcześniej – przerysuj z zaznaczoną nową rolą
          renderGroupSettings();
        })
      )
    );
  }
  layout.appendChild(list);

  // prawa kolumna: edytor wybranej roli
  const editor = el('div', 'gset__editor');
  const isEveryone = gset.roleId === 'everyone';
  const idx = isEveryone ? -1 : roleIdx(g, gset.roleId);
  if (!isEveryone && idx === -1) gset.roleId = 'everyone';
  const role = isEveryone || idx === -1 ? { id: 'everyone', name: '@everyone', color: null, perms: g.everyone } : g.roles[idx];
  const editable = canManage && (isEveryone || g.rank < idx);

  const nameInput = el('input', 'field');
  nameInput.value = role.name;
  nameInput.maxLength = 24;
  nameInput.disabled = !editable || isEveryone;
  let colorInput = null;
  let noColor = null;
  if (!isEveryone) {
    editor.appendChild(el('div', 'section-title', 'Nazwa roli'));
    editor.appendChild(nameInput);
    editor.appendChild(el('div', 'section-title gset__spaced', 'Kolor'));
    const colorRow = el('div', 'gset__colorrow');
    colorInput = el('input', 'gset__color');
    colorInput.type = 'color';
    colorInput.value = role.color || '#99aab5';
    colorInput.disabled = !editable;
    const noColorLabel = el('label', 'gset__nocolor');
    noColor = document.createElement('input');
    noColor.type = 'checkbox';
    noColor.checked = !role.color;
    noColor.disabled = !editable;
    noColorLabel.append(noColor, document.createTextNode(' bez koloru'));
    colorInput.addEventListener('input', () => (noColor.checked = false));
    colorRow.append(colorInput, noColorLabel);
    editor.appendChild(colorRow);
  } else {
    editor.appendChild(el('div', 'groups__hint', 'Uprawnienia, które dostaje każdy członek grupy.'));
  }
  editor.appendChild(el('div', 'section-title gset__spaced', 'Uprawnienia'));
  const perms = permCheckboxes(g, role.perms, { editable, allowAdmin: !isEveryone });
  editor.appendChild(perms);

  const actions = el('div', 'group-card__actions');
  if (editable) {
    actions.appendChild(
      gsetButton(icon('check'), 'btn-primary btn-sm btn-iconly', () => {
        const chosen = Array.from(perms.querySelectorAll('input:checked')).map((b) => b.value);
        // Nieedytowalnych (niedostępnych dla Ciebie) uprawnień nie ruszamy – serwer i tak by je odrzucił.
        const payload = { groupId: g.id, roleId: role.id, perms: chosen };
        if (!isEveryone) {
          payload.name = nameInput.value;
          payload.color = noColor.checked ? null : colorInput.value;
        }
        groupAction('group:role:update', payload, () => toast('Zapisano rolę', true));
      }, { title: 'Zapisz rolę' })
    );
    if (!isEveryone) {
      actions.appendChild(
        gsetButton(icon('trash'), 'btn-secondary btn-sm btn-iconly btn-danger', () => {
          if (!confirm(`Usunąć rolę „${role.name}”? Osoby, które ją mają, stracą jej uprawnienia.`)) return;
          groupAction('group:role:delete', { groupId: g.id, roleId: role.id }, () => {
            gset.roleId = 'everyone';
            renderGroupSettings();
            toast('Usunięto rolę', true);
          });
        }, { title: 'Usuń rolę' })
      );
    }
  } else {
    actions.appendChild(el('div', 'groups__hint', canManage ? 'Ta rola jest wyżej lub na równi z Twoją – nie możesz jej zmieniać.' : 'Nie masz uprawnienia do zarządzania rolami.'));
  }
  editor.appendChild(actions);
  layout.appendChild(editor);
  body.appendChild(layout);
}

function gsetMembers(g, body) {
  if (gset.membersFor !== g.id) {
    body.appendChild(el('div', 'groups__empty', 'Wczytuję członków…'));
    fetchGsetMembers();
    return;
  }
  const canRoles = g.perms.includes('manageRoles');
  const canKick = g.perms.includes('kick');
  const members = gset.members
    .slice()
    .sort((a, b) => memberRank(g, a) - memberRank(g, b) || a.nick.localeCompare(b.nick, 'pl'));
  const sec = gsetSection(`Członkowie — ${members.length}`);
  if (canRoles) sec.appendChild(el('div', 'groups__hint', 'Ikona etykiety przy osobie otwiera listę ról do nadania. Role tworzysz w zakładce „Role”.'));
  members.forEach((m) => {
    const rank = memberRank(g, m);
    const isMe = m.id === myAccountId;
    const card = el('div', 'gset__member');
    const row = el('div', 'gset__memberrow');
    row.appendChild(makeAvatar(m.nick, 'avatar--sm'));
    const info = el('div', 'gset__memberinfo');
    const name = el('span', 'gset__membername', m.nick);
    info.appendChild(name);
    if (m.isOwner) info.appendChild(iconNode('span', 'member__crown', 'crown'));
    const chipRow = el('div', 'gset__chips');
    (m.roles || []).forEach((id) => {
      const r = g.roles.find((x) => x.id === id);
      if (!r) return;
      const chip = el('span', 'gset__chip', r.name);
      if (r.color) chip.style.borderColor = r.color;
      chipRow.appendChild(chip);
    });
    const left = el('div', 'gset__memberleft');
    left.append(info, chipRow);
    row.appendChild(left);

    const touchable = isMe || (!m.isOwner && g.rank < rank); // twórca może nadać role sobie, ale nikt nie zmienia ról twórcy
    const actions = el('div', 'gset__memberactions');
    if (canRoles && touchable) {
      // Ikona etykiety: nadawanie ról. Bez żadnej roli prowadzi do zakładki, w której się je tworzy.
      const assign = iconButton(
        'tag',
        g.roles.length ? `Nadaj rolę: ${m.nick}` : 'Najpierw utwórz rolę (zakładka Role)',
        () => {
          if (!g.roles.length) {
            toast('Nie ma jeszcze żadnej roli – utwórz ją w zakładce „Role”, potem nadasz ją tutaj.', true);
            gset.tab = 'roles';
            return renderGroupSettings();
          }
          gset.openMember = gset.openMember === m.id ? null : m.id;
          renderGroupSettings();
        }
      );
      if (gset.openMember === m.id) assign.classList.add('is-on');
      actions.appendChild(assign);
    }
    if (canKick && !isMe && !m.isOwner && g.rank < rank) {
      actions.appendChild(
        iconButton(
          'user-minus',
          `Wyrzuć ${m.nick} z grupy`,
          () => {
            if (!confirm(`Wyrzucić ${m.nick} z grupy? Wróci tylko z nowym kodem.`)) return;
            groupAction('group:kick', { groupId: g.id, accountId: m.id }, () => toast(`Wyrzucono ${m.nick}`, true));
          },
          { danger: true }
        )
      );
    }
    row.appendChild(actions);
    card.appendChild(row);

    if (gset.openMember === m.id && canRoles && touchable) {
      const picker = el('div', 'gset__picker');
      g.roles.forEach((r, i) => {
        const label = el('label', 'gset__pick');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = (m.roles || []).includes(r.id);
        box.disabled = !(g.rank < i); // tylko role niżej od Twojej najwyższej
        box.addEventListener('change', () => {
          const next = new Set(m.roles || []);
          if (box.checked) next.add(r.id);
          else next.delete(r.id);
          groupAction('group:member:roles', { groupId: g.id, accountId: m.id, roles: Array.from(next) }, () => {
            m.roles = Array.from(next); // od razu pokaż zmianę; potem dojdzie odświeżenie z serwera
          });
        });
        const dot = el('span', 'gset__dot');
        dot.style.background = r.color || 'var(--text-muted)';
        label.append(box, dot, document.createTextNode(` ${r.name}`));
        picker.appendChild(label);
      });
      card.appendChild(picker);
    }
    sec.appendChild(card);
  });
  body.appendChild(sec);
}

function renderGroupSettings() {
  if (gsetModal.classList.contains('hidden')) return;
  const g = gsetGroup();
  if (!g) return closeGroupSettings(); // grupa zniknęła (usunięta, wyjście)
  const body = $('gset-body');
  // Nie przerysowujemy w trakcie pisania w polu – inaczej zniknęłoby ci to, co wpisujesz.
  const active = document.activeElement;
  if (body.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && active.type !== 'checkbox') return;

  $('gset-title').textContent = g.name; // nazwa grupy nad menu, jak nazwa serwera na Discordzie
  document.querySelectorAll('.gset__tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === gset.tab));
  const paneInfo = GSET_PANES[gset.tab] || GSET_PANES.overview;
  $('gset-pane-title').textContent = paneInfo.title;
  $('gset-pane-lead').textContent = paneInfo.lead;
  const scroll = body.scrollTop;
  const fresh = el('div', 'gset__content');
  if (gset.tab === 'channels') gsetChannels(g, fresh);
  else if (gset.tab === 'roles') gsetRoles(g, fresh);
  else if (gset.tab === 'members') gsetMembers(g, fresh);
  else gsetOverview(g, fresh);
  body.replaceChildren(fresh);
  body.scrollTop = scroll;
}

document.querySelectorAll('.gset__tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    gset.tab = tab.dataset.tab;
    renderGroupSettings();
  })
);
$('gset-close').addEventListener('click', closeGroupSettings);
gsetModal.addEventListener('mousedown', (e) => {
  if (e.target === gsetModal) closeGroupSettings();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !gsetModal.classList.contains('hidden')) closeGroupSettings();
});
$('group-gear').addEventListener('click', () => {
  const g = myCurrentGroup();
  if (g) openGroupSettings(g.id);
});
$('channel-add').addEventListener('click', () => {
  const g = myCurrentGroup();
  if (!g) return;
  openGroupSettings(g.id, 'channels');
  setTimeout(() => $('gset-new-channel') && $('gset-new-channel').focus(), 30);
});

$('group-join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('group-code');
  const code = input.value.trim();
  if (!code) return;
  groupAction('group:join', { code }, (res) => {
    input.value = '';
    upsertGroup(res.group);
    toast(`Dołączono do grupy ${res.group.name}`, true);
    closeGroups();
    switchChannel(res.group.channel);
  });
});

$('group-create-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('group-name');
  const name = input.value.trim();
  if (!name) return;
  groupAction('group:create', { name }, (res) => {
    input.value = '';
    upsertGroup(res.group);
    toast(`Utworzono grupę ${res.group.name}`, true);
    renderGroupList(); // zostajemy w oknie, żeby od razu skopiować kod dla znajomych
  });
});

$('groups-close').addEventListener('click', closeGroups);
groupsModal.addEventListener('mousedown', (e) => {
  if (e.target === groupsModal) closeGroups();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !groupsModal.classList.contains('hidden')) closeGroups();
});

socket.on('groups', setGroups);

// Ktoś dołączył, wyszedł albo zmieniono role – odśwież listę członków (panel i ustawienia grupy).
socket.on('group:members-changed', ({ groupId }) => {
  const group = groupByChannel(currentChannel);
  if (group && group.id === groupId) loadGroupMembers();
  if (gset.groupId === groupId && !gsetModal.classList.contains('hidden')) {
    gset.membersFor = null; // wymusza ponowne pobranie
    renderGroupSettings();
  }
});

// Wyjście z grupy, wyrzucenie albo usunięcie grupy: znika z listy, a lokalna kopia jej czatów z archiwum.
socket.on('group:removed', async ({ groupId, channel, channels: removedChannels }) => {
  const group = groups.find((g) => g.id === groupId);
  const mine = removedByMe.delete(groupId);
  const ids = Array.isArray(removedChannels) && removedChannels.length ? removedChannels : [channel];
  groups = groups.filter((g) => g.id !== groupId);
  ids.forEach((id) => {
    unreadChannels.delete(id);
    mentionCounts.delete(id);
  });
  if (voice.active && voice.groupId === groupId) leaveVoice(false); // serwer już zakończył naszą rozmowę w tej grupie
  voiceLists.delete(groupId);
  if (ids.includes(currentChannel)) {
    currentChannel = null; // serwer zostawił to połączenie bez kanału – wchodzimy do innej grupy albo pokazujemy ekran powitalny
    ensureChannel();
  } else {
    renderChannels();
  }
  renderGroupList();
  renderGroupSettings();
  if (group && !mine) toast(`Grupa „${group.name}” została usunięta lub nie masz już do niej dostępu.`);
  try {
    await archive.opening;
    for (const id of ids) await archive.removeChannel(id);
  } catch (err) {
    handleArchiveError(err);
  }
});

// Usunięto jeden kanał grupy: jego wiadomości znikają też z archiwum lokalnego.
socket.on('group:channel-removed', async ({ groupId, channel }) => {
  unreadChannels.delete(channel);
  mentionCounts.delete(channel);
  const group = groups.find((g) => g.id === groupId);
  if (currentChannel === channel && group) {
    showChannelView(group.channel); // serwer przeniósł nas już na kanał główny grupy i zaraz wyśle jego historię
    toast('Ten kanał został usunięty.');
  }
  try {
    await archive.opening;
    await archive.removeChannel(channel);
  } catch (err) {
    handleArchiveError(err);
  }
});

socket.on('group:denied', ({ error }) => toast(error || 'Brak uprawnień.'));

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
    voiceRejoin = voice.groupId; // wrócimy na kanał tej grupy, gdy tylko uda się zalogować ponownie
    leaveVoice(false);
    toast('Utracono połączenie z serwerem – próbuję wrócić na kanał głosowy…');
  }
  voice.users = [];
  voiceLists.clear();
  // Bez serwera nie wiemy, czy grupy jeszcze istnieją (mogły zostać usunięte, a serwer – zrestartowany),
  // więc ich nazw i ikon nie pokazujemy, dopóki nie dostaniemy świeżej listy po ponownym zalogowaniu.
  serverSynced = false;
  groups = [];
  groupMembers = [];
  groupMembersFor = null;
  closeGroups();
  closeGroupSettings();
  renderChannels();
  renderGroupList();
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
    $('persistence-note').hidden = cfg.persistent !== false; // ostrzeżenie tylko, gdy serwer nie ma trwałej bazy
    serverInfo = { version: cfg.version || 'nieznana', party: Boolean(cfg.features && cfg.features.party) };
    renderVersionInfo();
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
