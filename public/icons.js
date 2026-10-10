// Własny zestaw ikon MyChat: proste ikony liniowe (SVG, 24×24), które przejmują kolor tekstu (currentColor).
// Użycie w kodzie: icon('trash') → element <svg>. W HTML: <span data-icon="trash"></span>.
(function () {
  const NS = 'http://www.w3.org/2000/svg';

  const ICONS = {
    play: '<path fill="currentColor" stroke="none" d="M8 5.6v12.8a1 1 0 0 0 1.52.85l10.4-6.4a1 1 0 0 0 0-1.7L9.52 4.75A1 1 0 0 0 8 5.6z"/>',
    popout: '<rect x="3" y="4.5" width="18" height="14" rx="2.5"/><rect x="12" y="11.5" width="6.5" height="4" rx="1" fill="currentColor" stroke="none"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
    minus: '<path d="M5 12h14"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M4 18l5-5 4 4 3-3 4 4"/>',
    music: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
    film: '<rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="M16 10.5l5-3v9l-5-3"/>',
    file: '<path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5"/>',
    'file-text': '<path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    archive: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>',
    paperclip: '<path d="M20 11.5l-7.8 7.8a4.5 4.5 0 0 1-6.4-6.4l8-8a3 3 0 0 1 4.2 4.2l-8 8a1.5 1.5 0 0 1-2.1-2.1l7.3-7.3"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14"/>',
    reply: '<path d="M9.5 7L4 12l5.5 5"/><path d="M4 12h9a7 7 0 0 1 7 7v1"/>',
    smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.2a4.2 4.2 0 0 0 7 0M9 9.5h.01M15 9.5h.01" stroke-width="2.4"/>',
    trash: '<path d="M4 7h16M10 7V4.5h4V7M6.5 7l1 12.2a1.5 1.5 0 0 0 1.5 1.3h6a1.5 1.5 0 0 0 1.5-1.3L17.5 7M10 11v6M14 11v6"/>',
    crown: '<path d="M3.5 18.5L2.8 8l5.2 4.3L12 5l4 7.3L21.2 8l-.7 10.5z"/><path d="M4.5 21.5h15"/>',
    volume: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>',
    'headphones-off': '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/><path d="M4 4l16 16" stroke="var(--bg-primary, #313338)" stroke-width="5"/><path d="M4 4l16 16"/>',
    'mic-off': '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 11 4.6M12 18v3M3 3l18 18"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8l1.6 2.3 2.7-.6.6 2.7 2.7.9-.6 2.7L21 12l-1.9 1.2.6 2.7-2.7.9-.6 2.7-2.7-.6L12 21.2l-1.6-2.3-2.7.6-.6-2.7-2.7-.9.6-2.7L3 12l1.9-1.2-.6-2.7 2.7-.9.6-2.7 2.7.6z"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><circle cx="17.5" cy="9" r="2.5"/><path d="M17.5 14c2.5 0 4.5 1.7 4.5 4.5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5"/>',
    idcard: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="11" r="2"/><path d="M6 16c.4-1.6 1.6-2.4 3-2.4s2.6.8 3 2.4M15 10h3M15 14h3"/>',
    text: '<path d="M3 19L8.5 5 14 19M5.2 14h6.6"/><path d="M16 12.5a3 3 0 0 1 5 2.2V19M21 16h-3a2 2 0 1 0 0 3"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-.9 2-1.8 0-1.4-1-1.6-1-2.7 0-.9.7-1.5 1.6-1.5H17a4 4 0 0 0 4-4C21 6.8 17 3 12 3z"/><path d="M7.5 11.5h.01M10 7.5h.01M14.5 7.5h.01" stroke-width="2.4"/>',
    chat: '<path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-6l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/>',
    star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8 6.8 19.6l1-5.8L3.5 9.7l5.9-.8z"/>',
    warning: '<path d="M12 3.5L2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.2h.01"/>',
    hourglass: '<path d="M6 3h12M6 21h12M7 3c0 5 3 6 5 9-2 3-5 4-5 9M17 3c0 5-3 6-5 9 2 3 5 4 5 9"/>',
    sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
    'chevron-up': '<path d="M6 15l6-6 6 6"/>',
    'chevron-down': '<path d="M6 9l6 6 6-6"/>',
    'skip-back': '<path d="M6 5v14"/><path fill="currentColor" stroke="none" d="M19 6v12L9.5 12z"/>',
    'skip-next': '<path d="M18 5v14"/><path fill="currentColor" stroke="none" d="M5 6v12l9.5-6z"/>',
    size: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
    cinema: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M7 21h10"/>',
    save: '<path d="M5 3h11l4 4v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v6h8V3M7 21v-7h10v7"/>',
  };

  function icon(name) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', `icon icon--${name}`);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.innerHTML = ICONS[name] || ''; // wyłącznie stałe znaczniki z tej mapy, nigdy dane od użytkowników
    return svg;
  }

  // Element z ikoną i (opcjonalnym) podpisem, np. iconNode('button', 'icon-btn', 'trash').
  function iconNode(tag, className, name, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.appendChild(icon(name));
    if (text) node.appendChild(document.createTextNode(` ${text}`));
    return node;
  }

  // Ustawia w istniejącym elemencie ikonę i podpis (zastępuje jego zawartość).
  function setIcon(node, name, text) {
    node.replaceChildren(icon(name));
    if (text) node.appendChild(document.createTextNode(` ${text}`));
    return node;
  }

  window.icon = icon;
  window.iconNode = iconNode;
  window.setIcon = setIcon;

  // Statyczny HTML: <span data-icon="gear"></span> zamienia się na ikonę.
  document.querySelectorAll('[data-icon]').forEach((node) => node.replaceChildren(icon(node.dataset.icon)));
})();
