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

let settings = store.get('mychat.settings', { theme: 'dark', accent: '#5865f2', sound: true });
let profile = store.get('mychat.profile', { nick: '', avatar: null });

let myNick = null;
let pendingAvatar = profile.avatar; // avatar wybrany na ekranie logowania
let avatarTarget = 'login';
let lastNick = null;
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
}

// ---------- Avatary ----------
function setAvatarVisual(node, nick, avatar) {
  if (avatar && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar)) {
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

function setMyAvatar(avatar) {
  profile.avatar = avatar;
  store.set('mychat.profile', profile);
  avatars.set(myNick, avatar);
  refreshAvatars();
  socket.timeout(10000).emit('avatar', avatar, (err, res) => {
    if (err || !res || !res.ok) toast((res && res.error) || 'Nie udało się zapisać avatara.');
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
  img.addEventListener('click', () => openLightbox(img.src));
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

// Karta pliku z historii: zawartość jest pobierana z serwera dopiero po kliknięciu.
function makeRemoteFileCard(m, onLoad) {
  const card = el('div', 'filecard');
  card.appendChild(el('div', 'filecard__icon', fileIcon(m.mime, m.name)));
  const info = el('div', 'filecard__info');
  info.appendChild(el('div', 'filecard__name', m.name));
  info.appendChild(el('div', 'filecard__size', formatSize(m.size)));
  card.appendChild(info);

  const inline = INLINE_IMAGE.test(m.mime) || INLINE_VIDEO.test(m.mime) || INLINE_AUDIO.test(m.mime);
  const btn = el('button', 'icon-btn', inline ? '👁' : '⬇');
  btn.type = 'button';
  btn.title = inline ? 'Pokaż' : 'Pobierz';
  btn.addEventListener('click', () => {
    btn.disabled = true;
    socket.timeout(60000).emit('getFile', m.id, (err, res) => {
      btn.disabled = false;
      if (err || !res || !res.ok) return toast((res && res.error) || 'Nie udało się pobrać pliku.');
      const content = makeFileContent({ ...m, data: res.data }, onLoad);
      card.replaceWith(content);
      if (!inline) content.querySelector('a[download]')?.click(); // od razu pobierz
      onLoad();
    });
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
function sweepExpired() {
  const cutoff = Date.now() - retentionMs;
  messagesEl.querySelectorAll('[data-time]').forEach((node) => {
    if (Number(node.dataset.time) >= cutoff) return;
    node.querySelectorAll('[src^="blob:"], [href^="blob:"]').forEach((n) => {
      URL.revokeObjectURL(n.getAttribute('src') || n.getAttribute('href'));
    });
    node.remove();
  });
}

function addMessage(m, { historic = false } = {}) {
  const mine = m.senderId === socket.id;
  const stick = historic || mine || isNearBottom();
  const first = m.nick !== lastNick || m.time - lastMessageTime > GROUP_WINDOW_MS;
  const wrap = el('div', 'msg' + (first ? ' msg--first' : '') + (historic ? ' msg--static' : ''));
  wrap.dataset.time = m.time;

  if (first) {
    wrap.appendChild(makeAvatar(m.nick, 'msg__avatar'));
    const head = el('div', 'msg__head');
    const author = el('span', 'msg__author', m.nick);
    author.style.color = colorFor(m.nick);
    head.appendChild(author);
    head.appendChild(el('span', 'msg__time', formatTime(m.time)));
    wrap.appendChild(head);
  } else {
    wrap.appendChild(el('span', 'msg__hovertime', formatTime(m.time)));
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
  list.forEach((u) => avatars.set(u.nick, u.avatar));
  onlineEl.textContent = `${list.length} online`;
  membersTitleEl.textContent = `ONLINE — ${list.length}`;
  membersListEl.replaceChildren(
    ...list.map((u) => {
      const row = el('div', 'member');
      row.appendChild(makeAvatar(u.nick, 'avatar--sm avatar--online'));
      const name = el('span', 'member__name', u.nick);
      name.style.color = colorFor(u.nick);
      row.appendChild(name);
      return row;
    })
  );
  refreshAvatars();
}

// ---------- Dźwięk ----------
let audioCtx;
function beep() {
  if (!settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    [660, 880].forEach((freq, i) => {
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
function join(nick) {
  socket.emit('join', { nick, avatar: profile.avatar }, (res) => {
    if (!res || !res.ok) {
      loginError.textContent = (res && res.error) || 'Nie udało się dołączyć.';
      myNick = null;
      loginScreen.classList.remove('hidden');
      chatScreen.classList.add('hidden');
      return;
    }
    myNick = res.nick;
    avatars.set(myNick, profile.avatar);
    loginError.textContent = '';
    loginScreen.classList.add('hidden');
    chatScreen.classList.remove('hidden');

    meNameEl.textContent = myNick;
    meAvatarEl.dataset.nick = myNick;
    $('settings-avatar').dataset.nick = myNick;
    refreshAvatars();
    messageInput.focus();
  });
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const nick = nickInput.value.trim();
  if (!nick) return;
  profile = { nick, avatar: pendingAvatar };
  store.set('mychat.profile', profile);
  join(nick);
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
  author.style.color = colorFor(myNick);
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
  socket.timeout(10000).emit('gif', url, (err, res) => {
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
      'Wyszukiwarka GIFów jest wyłączona (brak klucza GIPHY_API_KEY na serwerze). Wklej link https do GIFa lub obrazka.';
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
  renderSettingsOptions();
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
lightbox.addEventListener('click', () => lightbox.classList.add('hidden'));

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
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

// ---------- Zdarzenia z serwera ----------
socket.on('message', (m) => addMessage(m));
socket.on('system', addSystem);

// Historia z ostatnich dni – przychodzi po (ponownym) dołączeniu do czatu.
socket.on('history', (list) => {
  messagesEl.replaceChildren();
  lastNick = null;
  lastMessageTime = 0;
  const days = retentionDays === 1 ? '1 dniu' : `${retentionDays} dniach`;
  messagesEl.appendChild(el('div', 'system system--info', `Wiadomości i pliki są usuwane po ${days}.`));
  list.forEach((m) => addMessage(m, { historic: true }));
  sweepExpired();
  scrollToBottom();
});
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

// ---------- Start ----------
applySettings();
nickInput.value = profile.nick || '';
updateLoginAvatar();

fetch('/api/config')
  .then((r) => r.json())
  .then((cfg) => {
    gifSearchEnabled = Boolean(cfg.gifSearch);
    if (cfg.maxFileBytes) maxFileBytes = cfg.maxFileBytes;
    if (cfg.retentionMs) {
      retentionMs = cfg.retentionMs;
      retentionDays = cfg.retentionDays;
    }
  })
  .catch(() => {});

// Co 10 minut sprawdzamy, czy jakieś wiadomości na ekranie nie wygasły (np. przy długo otwartej karcie).
setInterval(sweepExpired, 10 * 60 * 1000);
