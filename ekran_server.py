"""Zdalny ekran Szukajki: działa na maszynie InstaBox. Trzyma prawdziwą przeglądarkę (Chromium przez Playwright)
z osobną kartą dla każdego telefonu, wykonuje akcje (otwórz, kliknij, przewiń, wpisz, klawisz, wstecz…) i odsyła
zrzut ekranu z tytułem i adresem. Telefon dostaje tylko obrazek – JavaScript działa tutaj.

Uruchomienie: EKRAN_TOKEN=… python server.py  (port EKRAN_PORT, domyślnie 8765). Każde żądanie poza /health musi mieć
nagłówek X-Ekran-Token równy EKRAN_TOKEN.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import shutil
import time
import queue
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

TOKEN = os.environ["EKRAN_TOKEN"]
with open(__file__, "rb") as _source:
    VERSION = hashlib.sha256(_source.read()).hexdigest()[:12]  # Szukajka wgrywa nową wersję, gdy ta się różni
PORT = int(os.environ.get("EKRAN_PORT", "8765"))
WIDTH, HEIGHT = 360, 560  # domyślny widok telefonu (Nokia: Szukajka zmniejsza zrzut do 232 px)


def view_of(body):
    """Wielkość widoku z żądania: w×h (px CSS), scale (gęstość pikseli: 2 = ostro na Retinie), q (jakość JPEG)."""
    view = body.get("view") if isinstance(body.get("view"), dict) else {}
    def num(key, low, high, default):
        try:
            return max(low, min(high, int(view.get(key, default))))
        except (TypeError, ValueError):
            return default
    out = {"w": num("w", 240, 480, WIDTH), "h": num("h", 320, 4000, HEIGHT), "scale": num("scale", 1, 2, 1), "q": num("q", 40, 85, 60),
           "fmt": "webp" if view.get("fmt") == "webp" else "jpeg"}
    out["clip"] = min(out["h"], num("clip", 100, 4000, out["h"]))  # zrzut tylko górnej części widoku (np. jeden ekran Nokii)
    out["base"] = min(out["h"], num("base", 200, 4000, out["h"]))  # okno dla aplikacji (Mapy, Jakdojade) – rośnie do h dla długich stron
    out["out"] = num("out", 0, 960, 0)  # szerokość gotowego obrazu (Nokia: 232 px) – bez przepakowywania na serwerze Szukajki
    return out
MAX_SESSIONS = 3
IDLE_SECONDS = 20 * 60
KEYS = {"Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown",
        "Home", "End", "Space"}

# Dźwięk na żywo: przeglądarka gra do wirtualnej karty dźwiękowej (PulseAudio, „null sink”), a /audio nadaje to, co
# gra, jako strumień MP3 (ffmpeg) – tylko na żywo, nic nie jest zapisywane. Pakiety doinstalowujemy, gdy ich brak.
PULSE = "/tmp/ekran-pulse"
AUDIO_ENV = dict(os.environ, PULSE_SERVER="unix:" + PULSE)
audio = {"state": "brak", "error": ""}
listeners = []


def start_pulse():
    if os.path.exists(PULSE):
        if subprocess.run(["pactl", "info"], env=AUDIO_ENV, capture_output=True, timeout=10).returncode == 0:
            return True
        os.remove(PULSE)
    subprocess.run(["pulseaudio", "-D", "-n", "--exit-idle-time=-1", "--disallow-exit",
                    "--load=module-null-sink sink_name=ekran sink_properties=device.description=ekran",
                    f"--load=module-native-protocol-unix socket={PULSE} auth-anonymous=1"],
                   capture_output=True, timeout=30)
    for _ in range(20):
        if subprocess.run(["pactl", "set-default-sink", "ekran"], env=AUDIO_ENV, capture_output=True, timeout=10).returncode == 0:
            return True
        time.sleep(0.25)
    return False


def setup_audio(install=False):
    """Wirtualna karta dźwiękowa. install=True: doinstaluj pulseaudio i ffmpeg (apt), gdy ich nie ma."""
    try:
        missing = [name for name in ("pulseaudio", "pactl", "ffmpeg") if not shutil.which(name)]
        if missing and install:
            audio.update(state="instaluję")
            sudo = [] if os.geteuid() == 0 else ["sudo", "-n"]
            env = dict(os.environ, DEBIAN_FRONTEND="noninteractive")
            subprocess.run(sudo + ["apt-get", "update", "-q"], capture_output=True, timeout=300, env=env)
            done = subprocess.run(sudo + ["apt-get", "install", "-y", "-q", "--no-install-recommends", "pulseaudio",
                                          "pulseaudio-utils", "ffmpeg"], capture_output=True, text=True, timeout=600, env=env)
            missing = [name for name in ("pulseaudio", "pactl", "ffmpeg") if not shutil.which(name)]
            if missing:
                audio.update(state="błąd", error=(done.stderr or done.stdout or "apt-get")[-300:])
                return False
        if missing:
            return False
        if not start_pulse():
            audio.update(state="błąd", error="PulseAudio nie wystartował")
            return False
        audio.update(state="gotowy", error="")
        return True
    except (OSError, subprocess.SubprocessError) as err:
        audio.update(state="błąd", error=str(err)[:300])
        return False


def sound_playing():
    """Czy przeglądarka coś teraz gra: aktywny (nie wstrzymany) strumień w wirtualnej karcie dźwiękowej."""
    if audio["state"] != "gotowy":
        return False
    try:
        out = subprocess.run(["pactl", "list", "sink-inputs"], env=AUDIO_ENV, capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return "Corked: no" in out


def launch_browser():
    executable = next((p for p in (shutil.which("chromium"), shutil.which("chromium-browser"), shutil.which("google-chrome"))
                       if p), None)
    return playwright.chromium.launch(executable_path=executable, args=["--no-sandbox", "--disable-dev-shm-usage"],
                                      ignore_default_args=["--mute-audio"],  # Playwright domyślnie wycisza przeglądarkę
                                      env=AUDIO_ENV if audio["state"] == "gotowy" else None)


def install_audio_later():
    """Brak pakietów: instalacja w tle; gdy się uda, przeglądarka uruchomi się od nowa z dźwiękiem przy pierwszej
    akcji bez otwartych kart albo przy włączeniu dźwięku (to zamyka otwarte strony – jednorazowo)."""
    if setup_audio(install=True):
        audio["restart"] = True


playwright = sync_playwright().start()
if not setup_audio():
    threading.Thread(target=install_audio_later, daemon=True).start()
browser = launch_browser()
version = browser.version.split(".")[0]
USER_AGENT = (f"Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) "
              f"Chrome/{version}.0.0.0 Mobile Safari/537.36")  # widok mobilny, jak telefon z Chrome
sessions = {}
# Pomocnicze funkcje JS: strony budują okienka (zgody na ciasteczka, logowanie, menu) w Shadow DOM, którego zwykłe
# document.querySelectorAll i elementFromPoint nie widzą – schodzimy do otwartych shadowRoot.
DEEP = (
    "const deepAt = (x, y) => { let e = document.elementFromPoint(x, y); while (e && e.shadowRoot) { "
    "const i = e.shadowRoot.elementFromPoint(x, y); if (!i || i === e) break; e = i; } return e; };"
    "const deepActive = () => { let e = document.activeElement; while (e && e.shadowRoot && e.shadowRoot.activeElement) "
    "e = e.shadowRoot.activeElement; return e; };"
    "const deepAll = sel => { const out = []; const walk = root => { out.push(...root.querySelectorAll(sel)); "
    "for (const h of root.querySelectorAll('*')) if (h.shadowRoot) walk(h.shadowRoot); }; walk(document); return out; };"
    "const within = (a, b) => { for (let n = b; n; n = n.parentNode || n.host) if (n === a) return true; return false; };"
    "const up = e => e.parentElement || (e.getRootNode && e.getRootNode().host) || null;"
)
# Przed wpisaniem: kursor w polu tekstowym – aktywnym, klikniętym (albo jego wnętrzu/otoczeniu) lub pierwszym widocznym.
FOCUS = ("""([x, y]) => {""" + DEEP + """
  const editable = e => !!e && (e.isContentEditable || (/^(INPUT|TEXTAREA)$/.test(e.tagName)
                                && !/^(hidden|button|submit|checkbox|radio|image|file|range|color)$/i.test(e.type || '')));
  if (editable(deepActive())) return 'active';
  const sel = 'input,textarea,[contenteditable=""],[contenteditable="true"]';
  const shown = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; };
  let e = x === null ? null : deepAt(x, y);
  if (e && !editable(e)) e = e.closest(sel) || e.querySelector(sel) || (e.parentElement && e.parentElement.querySelector(sel));
  if (!editable(e) || !shown(e)) e = deepAll(sel).find(v => editable(v) && shown(v));
  if (!e) return 'none';
  e.focus();
  return editable(deepActive()) ? 'focused' : 'none';
}""")
# „Czy kliknięcie coś zmieniło”: adres, liczba elementów, widoczny tekst (pokazane/schowane menu), fokus, przewinięcie.
ACTIVE = ("() => { " + DEEP + "const e = deepActive(); if (!e) return ''; "
          "return e.tagName + '#' + e.id + '.' + String(e.className).slice(0, 40) + ' v=' + String(e.value || e.innerText || '').slice(0, 40)"
          " + ' ' + JSON.stringify(e.getBoundingClientRect()); }")
VALUE = "() => { " + DEEP + "const e = deepActive(); return e ? String(e.value !== undefined ? e.value : e.innerText) : ''; }"
SET_VALUE = ("""(text) => {""" + DEEP + """
  const e = deepActive();
  if (!e) return;
  if (e.isContentEditable) { e.innerText += text; }
  else {
    const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, (e.value || '') + text);
  }
  e.dispatchEvent(new InputEvent('input', {bubbles: true, data: text, inputType: 'insertText'}));
  e.dispatchEvent(new Event('change', {bubbles: true}));
}""")
SUBMIT = ("""() => {""" + DEEP + """
  const e = deepActive();
  if (!e) return;
  if (e.form) { e.form.requestSubmit ? e.form.requestSubmit() : e.form.submit(); return; }
  for (const type of ['keydown', 'keypress', 'keyup'])
    e.dispatchEvent(new KeyboardEvent(type, {key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true}));
}""")
# Przewinięcie o dy px: strona, a gdy się nie przewija – największy widoczny przewijany element (panel aplikacji).
SCROLL = ("""([dir, shown]) => {""" + DEEP + """
  // pasek przypięty do góry/dołu ekranu (nagłówek strony): zasłania treść, więc krok jest o niego krótszy
  const bar = y => {
    let found = null;
    for (const x of [10, innerWidth / 2, innerWidth - 10]) {
      for (let e = document.elementFromPoint(x, y); e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
        const pos = getComputedStyle(e).position;
        if (pos !== 'fixed' && pos !== 'sticky') continue;
        const r = e.getBoundingClientRect();
        if (r.height < shown * 0.4 && (!found || (y < 5 ? r.bottom > found.bottom : r.top < found.top))) found = r;
        break;
      }
    }
    return found;
  };
  const top = bar(2), bottom = bar(shown - 2);
  const step = Math.max(80, shown - (top ? Math.max(0, top.bottom) : 0) - (bottom ? Math.max(0, shown - bottom.top) : 0));
  const se = document.scrollingElement || document.documentElement;
  const before = se.scrollTop;
  scrollBy({top: dir * step, behavior: 'instant'});  // nowy obraz zaczyna się dokładnie tam, gdzie kończył się poprzedni
  if (Math.abs(se.scrollTop - before) > 2) return 'strona';
  let best = null, area = 0, seen = 0;
  for (const e of deepAll('*')) {
    if (e.scrollHeight <= e.clientHeight + 5 || e.clientHeight < 60) continue;
    const r = e.getBoundingClientRect();
    const h = Math.max(0, Math.min(r.bottom, shown) - Math.max(r.top, 0));
    const vis = h * Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    if (vis <= area || !/(auto|scroll|overlay)/.test(getComputedStyle(e).overflowY)) continue;
    if ((dir > 0 && e.scrollTop + e.clientHeight >= e.scrollHeight - 1) || (dir < 0 && e.scrollTop <= 0)) continue;  // już na końcu
    area = vis; best = e; seen = h;
  }
  if (!best) return '';
  best.scrollBy({top: dir * Math.max(40, seen), behavior: 'instant'});  // panel aplikacji: o jego widoczną wysokość
  return 'panel';
}""")
# Panel aplikacji (największy widoczny przewijany element) – oznaczony, żeby kolejne kroki trafiały w ten sam.
PANEL = ("""(shown) => {""" + DEEP + """
  for (const e of deepAll('[data-ekran-panel]')) e.removeAttribute('data-ekran-panel');
  let best = null, area = 0, box = null;
  for (const e of deepAll('*')) {
    if (e.scrollHeight <= e.clientHeight + 5 || e.clientHeight < 60) continue;
    const r = e.getBoundingClientRect(), t = Math.max(r.top, 0), b = Math.min(r.bottom, shown);
    const vis = Math.max(0, b - t) * Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    if (vis <= area || !/(auto|scroll|overlay)/.test(getComputedStyle(e).overflowY)) continue;
    area = vis; best = e; box = [Math.ceil(t), Math.floor(b) - 1];  // bez wiersza pikseli sąsiedniego paska (kreska na łączeniu)
  }
  if (!best || box[1] - box[0] < 80) return null;
  best.setAttribute('data-ekran-panel', '1');
  return {top: box[0], bottom: box[1], scroll: Math.round(best.scrollTop), max: Math.round(best.scrollHeight - best.clientHeight)};
}""")
PANEL_SET = ("""(top) => {""" + DEEP + """
  const e = deepAll('[data-ekran-panel]')[0];
  if (!e) return null;
  e.scrollTo({top: top, behavior: 'instant'});
  return Math.round(e.scrollTop);
}""")
# Elementy przypięte nad panelem (pływający przycisk „Kup bilet”, przyklejony nagłówek): przy przewijaniu panelu stoją
# w miejscu, więc w każdym sklejonym kawałku zasłaniałyby listę – na czas robienia kolejnych odsłon są ukryte.
OVERLAYS = ("""([top, bottom, hide]) => {""" + DEEP + """
  if (!hide) {
    for (const e of deepAll('[data-ekran-ukryte]')) { e.style.visibility = e.getAttribute('data-ekran-ukryte'); e.removeAttribute('data-ekran-ukryte'); }
    return 0;
  }
  const panel = deepAll('[data-ekran-panel]')[0];
  if (!panel) return 0;
  let n = 0;
  for (const e of deepAll('*')) {
    if (e === panel || within(e, panel)) continue;  // panel i to, co go zawiera
    const r = e.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom <= top || r.top >= bottom || r.height > (bottom - top) * 0.7) continue;
    const pos = getComputedStyle(e).position;
    if (!(pos === 'fixed' || pos === 'sticky' || (pos === 'absolute' && !within(panel, e)))) continue;
    let up = e.parentElement, done = false;  // ukryty rodzic wystarczy
    for (; up; up = up.parentElement) if (up.hasAttribute('data-ekran-ukryte')) { done = true; break; }
    if (done) continue;
    e.setAttribute('data-ekran-ukryte', e.style.visibility || '');
    e.style.visibility = 'hidden';
    n++;
  }
  return n;
}""")
# Wygląd klikanego przycisku (np. play ↔ pauza zmienia tylko ikonę SVG): najbliższy klikalny przodek elementu w punkcie.
TARGET = ("""([x, y]) => {""" + DEEP + """
  let e = deepAt(x, y);
  for (let i = 0; e && i < 5; i++, e = up(e))
    if (e.matches && e.matches('a,button,[role=button],[onclick],[tabindex],label,summary')) break;
  return e && e.outerHTML ? e.outerHTML.slice(0, 3000) : '';
}""")
# Zapasowe kliknięcie (strona nie zareagowała na mysz): także na grafice SVG, która nie ma metody click().
FALLBACK_CLICK = ("""([x, y]) => {""" + DEEP + """
  const e = deepAt(x, y);
  if (!e) return;
  if (typeof e.click === 'function') e.click();
  else e.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y}));
}""")
# Klikalne elementy widoczne na ekranie (linki, przyciski, pola): telefon z klawiaturą skacze po nich strzałkami.
CLICKABLES = ("""() => {""" + DEEP + """
  const sel = 'a[href],button,input:not([type=hidden]),textarea,select,summary,label[for],[role=button],[role=link],'
            + '[role=tab],[role=menuitem],[role=option],[role=checkbox],[onclick],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
  const out = [];
  for (const e of deepAll(sel)) {
    const r = e.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
    const st = getComputedStyle(e);
    if (st.visibility === 'hidden' || +st.opacity === 0 || st.pointerEvents === 'none') continue;
    // link zawinięty na kilka linii: środek całego prostokąta wypada obok tekstu – klikamy w pierwszą widoczną linię
    const lines = [...e.getClientRects()].filter(q => q.width >= 4 && q.height >= 4 && q.bottom > 0 && q.top < innerHeight
                                                      && q.right > 0 && q.left < innerWidth);
    const q = lines[0] || r;
    const cx = Math.min(Math.max(q.left + q.width / 2, 1), innerWidth - 2), cy = Math.min(Math.max(q.top + q.height / 2, 1), innerHeight - 2);
    const top = deepAt(cx, cy);
    if (!top || !(within(e, top) || within(top, e))) continue;  // zasłonięte (np. okienkiem)
    // element w elemencie: link/przycisk zawierający coś klikalnego liczy się raz; ogólny pojemnik (tabindex, role –
    // np. okienko zgody OneTrust na Polsat Sport) ustępuje przyciskom w środku, inaczej ramka nie wejdzie na „Akceptuj”
    const strong = el => /^(A|BUTTON|LABEL|SUMMARY|INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
    const outer = out.filter(o => within(o.el, e));
    if (outer.some(o => strong(o.el))) continue;
    for (const o of outer) out.splice(out.indexOf(o), 1);
    if (out.some(o => within(e, o.el))) continue;
    const field = /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) && !/^(button|submit|reset|checkbox|radio|image|file|range|color)$/i.test(e.type || '')
                  || e.isContentEditable;
    const labelled = e.getAttribute('aria-labelledby');
    const byId = labelled ? labelled.split(' ').map(id => (e.getRootNode().getElementById(id) || {}).innerText || '').join(' ') : '';
    const text = (e.innerText || e.value || e.getAttribute('aria-label') || byId || e.getAttribute('title') || e.getAttribute('placeholder')
                  || (e.querySelector('img[alt]') || {}).alt || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
    out.push({el: e, x: Math.max(0, r.left), y: Math.max(0, r.top), r: Math.min(r.right, innerWidth), b: Math.min(r.bottom, innerHeight),
              cx: Math.round(cx), cy: Math.round(cy), t: text, f: field ? 1 : 0});
    if (out.length >= 400) break;
  }
  return out.map(o => ({x: Math.round(o.x), y: Math.round(o.y), r: Math.round(o.r), b: Math.round(o.b), cx: o.cx, cy: o.cy, t: o.t, f: o.f}));
}""")
FIELD = ("""() => {""" + DEEP + """
  const e = deepActive();
  const ok = e && (e.isContentEditable || (/^(INPUT|TEXTAREA)$/.test(e.tagName)
                   && !/^(hidden|button|submit|checkbox|radio|image|file|range|color)$/i.test(e.type || '')));
  return ok ? (e.getAttribute('aria-label') || e.placeholder || e.name || e.title || 'pole').slice(0, 60) : '';
}""")
# Czy kliknięty element to wyszukiwarka (lupa, „Szukaj”): wtedy chwilę czekamy, aż otworzy się jej pole.
SEARCHY = ("""([x, y]) => {""" + DEEP + """
  let e = deepAt(x, y);
  for (let i = 0; e && i < 4; i++, e = up(e)) {
    const text = [e.getAttribute('aria-label'), e.title, e.className && String(e.className), e.getAttribute('href'),
                  e.id, (e.innerText || '').slice(0, 30)].join(' ');
    if (/szuk|search|wyszuk|lupa|find/i.test(text)) return true;
  }
  return false;
}""")
SIGNATURE = ("() => { " + DEEP + "const all = deepAll('*'); const a = deepActive(); "
             "return location.href + '|' + all.length + '|' + (document.body ? document.body.innerText.length : 0) + '|' + "
             "all.reduce((n, h) => n + (h.shadowRoot ? h.shadowRoot.textContent.length : 0), 0) + '|' + "
             "(a ? a.tagName : '') + '|' + scrollY; }")


def new_context(sid, view):
    context = browser.new_context(viewport={"width": view["w"], "height": view.get("base") or view["h"]}, device_scale_factor=view["scale"],
                                  is_mobile=True, has_touch=True, user_agent=USER_AGENT, locale="pl-PL",
                                  timezone_id="Europe/Warsaw")
    # link otwierający nową kartę (target=_blank, window.open): ekran pokazuje nową kartę
    context.on("page", lambda new_page, sid=sid: sessions.get(sid) and sessions[sid].update(page=new_page))
    return context


def page_for(sid, geo=None, view=None):
    view = view or {"w": WIDTH, "h": HEIGHT, "scale": 1, "q": 60}
    now = time.time()
    for old in [s for s, v in sessions.items() if now - v["used"] > IDLE_SECONDS]:
        sessions.pop(old)["context"].close()
    if sid not in sessions:
        while len(sessions) >= MAX_SESSIONS:
            oldest = min(sessions, key=lambda s: sessions[s]["used"])
            sessions.pop(oldest)["context"].close()
        context = new_context(sid, view)
        sessions[sid] = {"context": context, "page": context.new_page(), "used": now, "geo": None, "view": view}
    session = sessions[sid]
    if (session["view"]["w"], session["view"]["h"], session["view"]["scale"]) != (view["w"], view["h"], view["scale"]):
        # inny rozmiar ekranu (np. przełączenie na duży): nowa karta w nowym rozmiarze, ta sama strona
        url = session["page"].url if not session["page"].is_closed() else ""
        session["context"].close()
        session.update(context=new_context(sid, view), geo=None)
        session["page"] = session["context"].new_page()
        if url.startswith(("http://", "https://")):
            try:
                session["page"].goto(url, wait_until="domcontentloaded", timeout=12000)
            except PlaywrightError:
                pass
    session["view"] = view
    if geo and geo != session["geo"]:  # „Twoja lokalizacja” = miejscowość ustawiona w Szukajce (telefon nie podaje GPS)
        session["context"].grant_permissions(["geolocation"])
        session["context"].set_geolocation(geo)
        session["geo"] = geo
    session["used"] = now
    if session["page"].is_closed():
        session["page"] = session["context"].new_page()
    return session["page"]


def settle(page, wait=450):
    try:
        page.wait_for_load_state("domcontentloaded", timeout=4000)
    except PlaywrightError:
        pass
    page.wait_for_timeout(wait)


def run(page, script, arg=None, default=None):
    """page.evaluate odporne na przejście na inną stronę w trakcie (kliknięty link): po chwili jeszcze raz,
    a gdy dalej się nie da – `default`."""
    for attempt in range(2):
        try:
            return page.evaluate(script, arg) if arg is not None else page.evaluate(script)
        except PlaywrightError as err:
            if "context was destroyed" not in str(err) and "navigat" not in str(err).lower():
                raise
            settle(page, 300)
    return default


def title_of(page):
    try:
        return page.title()[:200]
    except PlaywrightError:
        settle(page, 300)
        try:
            return page.title()[:200]
        except PlaywrightError:
            return ""


def capture(page, view, top=0, tall=None):
    """Zrzut widocznej części strony (base64). Wprost przez Chromium (Page.captureScreenshot): bez czekania na czcionki
    i „stabilny” obraz, na którym page.screenshot potrafi utknąć na stronach z animacjami. Zapasowo page.screenshot."""
    try:
        cdp = page.context.new_cdp_session(page) if getattr(page, "_ekran_cdp", None) is None else page._ekran_cdp
        page._ekran_cdp = cdp
        x, y = run(page, "() => [scrollX, scrollY]", default=[0, 0])  # obszar zrzutu liczy się od początku dokumentu
        scale = view["out"] / view["w"] if view.get("out") else view["scale"]
        clip = {"x": x, "y": y + top, "width": view["w"], "height": tall or view.get("clip") or view["h"], "scale": scale}  # scale: ostrość
        return cdp.send("Page.captureScreenshot", {"format": view["fmt"], "quality": view["q"], "clip": clip})["data"]
    except PlaywrightError:
        page._ekran_cdp = None
        shot = page.screenshot(type="jpeg", quality=view["q"], timeout=6000, animations="disabled", caret="hide",
                               clip={"x": 0, "y": top, "width": view["w"], "height": tall or view.get("clip") or view["h"]})
        return base64.b64encode(shot).decode()


def clickables(page, width, height):
    """Klikalne elementy strony i jej ramek (iframe: np. „Nie jestem robotem”, osadzone mapy) we współrzędnych ekranu."""
    items = run(page, CLICKABLES, default=[]) or []
    for frame in page.frames[1:]:
        if len(items) >= 400:
            break
        try:
            box = frame.frame_element().bounding_box()
            if not box or box["width"] < 20 or box["height"] < 20 or box["y"] >= height or box["y"] + box["height"] <= 0:
                continue
            found = frame.evaluate(CLICKABLES)
        except PlaywrightError:
            continue  # ramka z innej domeny w trakcie ładowania, odłączona itp.
        for it in found or []:
            x1, y1 = max(0, it["x"] + box["x"]), max(0, it["y"] + box["y"])
            x2, y2 = min(width, it["r"] + box["x"]), min(height, it["b"] + box["y"])
            cx, cy = it["cx"] + box["x"], it["cy"] + box["y"]
            if x2 - x1 >= 6 and y2 - y1 >= 6 and 0 <= cx < width and 0 <= cy < height:
                items.append(dict(it, x=round(x1), y=round(y1), r=round(x2), b=round(y2), cx=round(cx), cy=round(cy)))
    return [dict(it, b=min(it["b"], height)) for it in items if it["y"] < height and it["cy"] < height][:400]


def memory_mb(page):
    """Pamięć zdalnej przeglądarki: cały Chromium (suma RSS jego procesów z /proc) i JavaScript tej karty."""
    total = 0
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as handle:
                cmd = handle.read(400)
            if b"chrom" not in cmd.lower() and b"headless_shell" not in cmd:
                continue
            try:  # PSS: pamięć wspólna procesów Chromium liczona raz (suma RSS by ją zawyżała)
                with open(f"/proc/{pid}/smaps_rollup", encoding="ascii", errors="replace") as handle:
                    found = [int(line.split()[1]) for line in handle if line.startswith("Pss:")]
            except OSError:
                found = []
            if not found:
                with open(f"/proc/{pid}/status", encoding="ascii", errors="replace") as handle:
                    found = [int(line.split()[1]) for line in handle if line.startswith("VmRSS:")]
            total += found[0] if found else 0  # kB
        except (OSError, ValueError):
            continue
    js = 0
    try:
        cdp = getattr(page, "_ekran_cdp", None) or page.context.new_cdp_session(page)
        page._ekran_cdp = cdp
        if getattr(page, "_ekran_perf", None) is not cdp:  # pomiary trzeba raz włączyć w tej sesji CDP
            cdp.send("Performance.enable")
            page._ekran_perf = cdp
        metrics = cdp.send("Performance.getMetrics")["metrics"]
        js = next((m["value"] for m in metrics if m["name"] == "JSHeapUsedSize"), 0)
    except PlaywrightError:
        pass
    return {"chromium": round(total / 1024), "karta_js": round(js / 1_048_576, 1)}


def compose_panel(page, view, width, shown, pause=150):
    """Aplikacja (Jakdojade, lista wyników): okno ma jeden ekran, a treść przewija się w panelu w środku. Panel
    przewijamy kawałek po kawałku i sklejamy w jeden długi obraz: górna część ekranu z panelem, kolejne odsłony panelu,
    na końcu dolny pasek aplikacji. Obszar z dalszej odsłony pamięta położenie panelu (ps) – kliknięcie ustawia je
    z powrotem. (części obrazu, obszary, {start, end} panelu) albo None, gdy nie ma czego sklejać."""
    info = run(page, PANEL, shown, default=None)
    if not info or info["max"] - info["scroll"] < 20:
        return None
    pt, pb, start = info["top"], info["bottom"], info["scroll"]
    ph, room = pb - pt, view["h"] - (shown - pb)  # ile panelu zmieści się w obrazie (dolny pasek doklejamy na końcu)
    first = clickables(page, width, shown)
    parts = [{"shot": capture(page, view, 0, pb), "h": pb}]
    items = [dict(it, b=min(it["b"], pb), ps=start) for it in first if it["cy"] < pb]
    cur, pos = pb, start
    run(page, OVERLAYS, [pt, pb, True], default=0)  # kolejne odsłony: sama lista, bez przypiętych przycisków i nagłówków
    while cur + 40 < room:
        want = min(pos + ph, info["max"], pos + room - cur)
        got = run(page, PANEL_SET, want, default=None)
        if got is None or got - pos < 5:
            break
        page.wait_for_timeout(pause)  # listy dorysowują elementy po przewinięciu
        delta, top = got - pos, pb - (got - pos)
        parts.append({"shot": capture(page, view, top, delta), "h": delta})
        for it in clickables(page, width, shown):
            if top <= it["cy"] < pb:
                items.append(dict(it, y=max(it["y"], top) - top + cur, b=min(it["b"], pb) - top + cur, ps=got))
        cur, pos = cur + delta, got
    run(page, OVERLAYS, [0, 0, False], default=0)
    run(page, PANEL_SET, start, default=None)  # zdalna strona wraca tam, gdzie zaczyna się obraz
    if len(parts) == 1:
        return None
    page.wait_for_timeout(80)
    foot = pb + 2  # panel kończy się 1 px niżej (ten wiersz pominęliśmy w kawałkach panelu) + zapas na zaokrąglenie skali
    if shown - foot > 2:
        parts.append({"shot": capture(page, view, foot, shown - foot), "h": shown - foot})
        items += [dict(it, y=max(it["y"], foot) - foot + cur, b=it["b"] - foot + cur) for it in first if it["cy"] >= foot]
    return parts, items[:400], {"start": start, "end": min(pos + ph, info["max"])}


def fit_height(page, view):
    """Wysokość okna dopasowana do strony. Aplikacje (Mapy Google, Jakdojade) rozciągają się na całe okno – w oknie
    wysokim na 3000 px treść ląduje u góry, a pod nią jest pustka; dostają okno wielkości ekranu telefonu. Długie strony
    (artykuły) – wysokie okno: kilka ekranów w jednym obrazie, przewijanie bez pytania serwera. Raz na adres strony."""
    base = view.get("base") or view["h"]
    if base >= view["h"]:
        return view["h"]
    known = getattr(page, "_ekran_fit", None)
    if known and known[0] == page.url:
        return known[1]
    try:
        if (page.viewport_size or {}).get("height") != base:
            page.set_viewport_size({"width": view["w"], "height": base})
            page.wait_for_timeout(120)
        content = run(page, "() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)",
                      default=base) or base
        height = view["h"] if content > base * 1.3 else base
        if height != base:
            page.set_viewport_size({"width": view["w"], "height": height})
            page.wait_for_timeout(150)
    except PlaywrightError:
        height = (page.viewport_size or {}).get("height") or base
    page._ekran_fit = (page.url, height)
    return height


def press_enter(page):
    """Enter; gdy strona go zignoruje (Mapy Google odrzucają symulowane klawisze) – wysłanie formularza pola
    albo zdarzenie Enter wysłane z poziomu strony."""
    before = run(page, SIGNATURE, default='nawigacja')
    page.keyboard.press("Enter")
    page.wait_for_timeout(700)
    if run(page, SIGNATURE, default='nawigacja') == before:
        run(page, SUBMIT)
        page.wait_for_timeout(500)
    return run(page, SIGNATURE, default='nawigacja') != before


def restart_with_audio():
    """Pakiety dźwięku doinstalowane w tle: przeglądarka od nowa, już z wirtualną kartą dźwiękową."""
    global browser
    for sid in list(sessions):
        try:
            sessions.pop(sid)["context"].close()
        except PlaywrightError:
            pass
    try:
        browser.close()
    except PlaywrightError:
        pass
    audio.pop("restart", None)
    browser = launch_browser()


def act(body):
    sid = str(body.get("sid") or "")[:40]
    if not sid:
        raise ValueError("brak sid")
    restarted = bool(audio.get("restart") and (sessions or body.get("action") == "audio"))
    if audio.get("restart") and (not sessions or body.get("action") == "audio"):
        restart_with_audio()
    if body.get("action") == "audio":  # Szukajka pyta o dźwięk (włączenie po doinstalowaniu pakietów zamyka strony)
        return {"audio": audio["state"], "audio_error": audio["error"], "listeners": len(listeners), "restarted": restarted}
    geo = body.get("geo")
    if not (isinstance(geo, dict) and all(isinstance(geo.get(k), (int, float)) for k in ("latitude", "longitude"))):
        geo = None
    started = time.monotonic()
    view = view_of(body)
    page = page_for(sid, {"latitude": float(geo["latitude"]), "longitude": float(geo["longitude"]), "accuracy": 1000}
                    if geo else None, view)
    width, height = view["w"], view["h"]
    action = body.get("action")
    if action == "open":
        url = str(body.get("url") or "")
        if urlparse(url).scheme not in ("http", "https"):
            raise ValueError("adres musi zaczynać się od http:// albo https://")
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=12000)  # bramka InstaBox czeka ok. 20 s
        except PlaywrightError as err:
            if "Timeout" not in str(err):
                raise
        settle(page, 800)
    elif action == "click":
        if isinstance(body.get("ps"), (int, float)):  # obszar z dalszej części sklejonego obrazu aplikacji: panel tam, gdzie był
            run(page, PANEL_SET, int(body["ps"]), default=None)
            page.wait_for_timeout(120)
        x = max(0, min(width - 1, float(body.get("x", 0))))
        y = max(0, min(height - 1, float(body.get("y", 0))))
        def state():  # strona + wygląd klikanego przycisku + czy coś gra (pauza zmienia tylko ikonę i dźwięk)
            return (run(page, SIGNATURE, default='nawigacja'), run(page, TARGET, [x, y], default=''), sound_playing())
        before, url_before = state(), page.url
        sessions[sid]["last"] = [x, y]
        sessions[sid]["search_click"] = bool(run(page, SEARCHY, [x, y], default=False))
        page.mouse.click(x, y)
        page.wait_for_timeout(350)
        if state() == before:  # nic się nie zmieniło: część stron mobilnych nie reaguje na mysz
            run(page, FALLBACK_CLICK, [x, y])
            page.wait_for_timeout(300)
        if page.url != url_before or run(page, "() => document.readyState", default="loading") != "complete":
            settle(page, 700)  # kliknięcie otworzyło inną stronę – zrzut dopiero, gdy się wczyta
        else:
            page.wait_for_timeout(350)  # nakładka, menu, pole: animacja i kursor
    elif action == "scroll":
        shown = min(view.get("clip") or height, (page.viewport_size or {}).get("height") or height)
        if isinstance(body.get("screen"), (int, float)) and body["screen"] > 50:
            shown = min(shown, int(body["screen"]))  # na żywo: o jeden ekran Nokii
        page.mouse.move(width / 2, shown / 2)  # środek tego, co widać na telefonie
        direction = 1 if int(body.get("dy", 0)) > 0 else -1
        glued = sessions[sid].get("panel")
        if glued and not body.get("screen") and glued.get("url") == page.url:  # sklejony obraz aplikacji: dalszy ciąg za nim
            target = glued["end"] if direction > 0 else max(0, glued["start"] - (glued["end"] - glued["start"]))
            if run(page, PANEL_SET, target, default=None) is not None:
                direction = 0
                page.wait_for_timeout(150)
        # o jeden pokazany ekran (bez nakładki), skryptem: kółko myszy w trybie telefonu Chrome mnoży (ok. 4×), a w
        # aplikacjach (Jakdojade) przewija się panel w środku, nie strona – wtedy największy widoczny przewijany element
        if direction and not run(page, SCROLL, [direction, shown], default=""):
            page.mouse.wheel(0, direction * shown / 4)
        page.wait_for_timeout(250)
    elif action == "type":
        text = str(body.get("text") or "")[:500]
        target = run(page, FOCUS, sessions[sid].get("last") or [None, None], default="none")
        if target == "none":
            raise ValueError("Nie widzę pola do wpisania tekstu – kliknij najpierw w pole na obrazie.")
        if text:
            page.keyboard.type(text, delay=15)
            if text not in (run(page, VALUE, default='') or ''):  # pole odrzuca symulowane klawisze (np. Mapy Google)
                page.keyboard.insert_text(text)  # jak klawiatura ekranowa telefonu
            if text not in (run(page, VALUE, default='') or ''):
                run(page, SET_VALUE, text)  # wartość + zdarzenie „input” (pola sterowane przez React i podobne)
        debug = {"target": target, "frames": len(page.frames), "active": run(page, ACTIVE, default='')}
        if body.get("enter"):
            query = (run(page, VALUE, default='') or '').strip()
            press_enter(page)
            maps = re.match(r"https://www\.google\.[a-z.]+/maps", page.url)
            if query and maps and not re.search(r"/maps/(?:search|place|dir)/", page.url):
                # Mapy Google przyjmują tylko „prawdziwy” Enter – ten sam wynik daje adres wyszukiwania
                try:
                    page.goto("https://www.google.com/maps/search/" + quote(query), wait_until="domcontentloaded", timeout=9000)
                except PlaywrightError as err:
                    if "Timeout" not in str(err):
                        raise  # wolne ładowanie to nie błąd – zrzut pokaże, co już jest
            settle(page, 1500)  # wyniki wyszukiwania (np. Mapy Google) ładują się chwilę
        else:
            page.wait_for_timeout(600)  # podpowiedzi pod polem
    elif action == "key":
        key = str(body.get("key") or "")
        if key not in KEYS:
            raise ValueError("nieznany klawisz")
        if key == "Enter":
            press_enter(page)
        else:
            page.keyboard.press(" " if key == "Space" else key)
        settle(page, 400)
    elif action in ("back", "forward", "reload"):
        try:
            if action == "back":
                if page.go_back(wait_until="domcontentloaded", timeout=10000) is None and len(page.context.pages) > 1:
                    page.close()  # nowa karta bez historii – wracamy do tej, z której ją otwarto
                    page = sessions[sid]["page"] = page.context.pages[-1]
            elif action == "forward":
                page.go_forward(wait_until="domcontentloaded", timeout=10000)
            else:
                page.reload(wait_until="domcontentloaded", timeout=12000)
        except PlaywrightError as err:
            if "Timeout" not in str(err):
                raise
        settle(page)
    elif action == "close":
        session = sessions.pop(sid, None)
        if session:
            session["context"].close()
        return {"closed": True}
    elif action != "shot":
        raise ValueError("nieznana akcja")
    if sid in sessions and sessions[sid]["page"] is not page and not sessions[sid]["page"].is_closed():
        page = sessions[sid]["page"]  # kliknięcie otworzyło nową kartę
        settle(page, 800)
    fitted = fit_height(page, view)
    view = dict(view, clip=min(view.get("clip") or view["h"], fitted))  # zrzut tylko tego, co jest w oknie
    height = view["clip"]
    acted = time.monotonic()
    field = ""
    if action == "click":
        field = run(page, FIELD, default="") or ""  # kliknięto pole tekstowe – telefon od razu pokaże wpisywanie
        if not field and sessions[sid].get("search_click"):  # nakładka wyszukiwania jeszcze się otwiera
            page.wait_for_timeout(600)
            field = run(page, FIELD, default="") or ""
    glued = (compose_panel(page, view, width, height, 60 if body.get("live") else 150)  # na żywo: szybciej, co sekundę
             if fitted < view["h"] and not body.get("single") else None)
    sessions[sid]["panel"] = glued and dict(glued[2], url=page.url)
    shot = None if glued else capture(page, view)
    shot_done = time.monotonic()
    result = {"title": title_of(page), "url": page.url, "width": width, "height": height, "shot": shot, "fmt": view["fmt"],
              "items": glued[1] if glued else clickables(page, width, view.get("clip") or height),
              "y": run(page, "() => Math.round(scrollY)", default=0)}
    if glued:
        result["parts"] = glued[0]  # Szukajka skleja kawałki w jeden obraz
        result["shot"] = glued[0][0]["shot"]
    if action == "click":
        result["field"] = field
    if action == "type":
        result["debug"] = debug
    if body.get("mem"):
        result["mem"] = memory_mb(page)
    result["sound"] = sound_playing()  # telefon pokaże „Gra dźwięk – słuchaj”, gdy jeszcze nikt nie słucha
    result["listeners"] = len(listeners)
    done = time.monotonic()
    result["ms"] = {"akcja": round((acted - started) * 1000), "zrzut": round((shot_done - acted) * 1000),
                    "reszta": round((done - shot_done) * 1000)}
    return result


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":  # odpowiada od razu, także gdy przeglądarka akurat pracuje
            self.reply(200, {"ok": True, "sessions": len(sessions), "chromium": CHROMIUM, "version": VERSION, "busy": jobs.qsize(),
                             "audio": audio["state"] if not audio.get("restart") else "gotowy po restarcie",
                             "audio_error": audio["error"], "listeners": len(listeners)})
        elif self.path.startswith("/audio"):
            self.stream_audio()
        else:
            self.reply(404, {"error": "nie ma"})

    def stream_audio(self):
        """Strumień MP3 tego, co gra zdalna przeglądarka (na żywo). Link podpisany przez Szukajkę: t=ważność.podpis."""
        ticket = (parse_qs(urlparse(self.path).query).get("t") or [""])[0]
        expires, _, sig = ticket.partition(".")
        good = hmac.new(TOKEN.encode(), f"audio:{expires}".encode(), hashlib.sha256).hexdigest()[:32]
        if not expires.isdigit() or int(expires) < time.time() or not hmac.compare_digest(sig, good):
            self.reply(403, {"error": "link do dźwięku wygasł – otwórz go ponownie w Szukajce"})
            return
        if audio["state"] != "gotowy" or audio.get("restart"):
            self.reply(503, {"error": f"dźwięk niegotowy: {audio['state']} {audio['error']}"})
            return
        if len(listeners) >= 2:
            self.reply(429, {"error": "dźwięk już leci do dwóch odbiorników"})
            return
        proc = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-f", "pulse", "-fragment_size", "1024", "-i", "ekran.monitor",
                                 "-ac", "1", "-ar", "22050", "-b:a", "48k", "-f", "mp3", "-flush_packets", "1", "pipe:1"],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=AUDIO_ENV)
        listeners.append(proc)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Cache-Control", "no-store")
            self.send_header("icy-name", "Szukajka - zdalny ekran")
            self.end_headers()
            while True:
                chunk = proc.stdout.read1(4096) if hasattr(proc.stdout, "read1") else proc.stdout.read(4096)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass  # telefon przestał słuchać
        finally:
            proc.kill()
            listeners.remove(proc)

    def do_POST(self):
        if self.path != "/act" or not hmac.compare_digest(self.headers.get("X-Ekran-Token", ""), TOKEN):
            self.reply(403, {"error": "brak dostępu"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > 20000:
            self.reply(413, {"error": "za duże"})
            return
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            self.reply(400, {"error": "zły JSON"})
            return
        job = {"body": body, "done": threading.Event()}
        jobs.put(job)
        job["done"].wait(120)
        if "result" in job:
            self.reply(200, job["result"])
        else:
            self.reply(400, {"error": job.get("error") or "przeglądarka nie zdążyła"})


CHROMIUM = browser.version
jobs = queue.Queue()  # akcje wykonuje jeden wątek (Playwright sync działa tylko w wątku, który go uruchomił)

if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    while True:
        job = jobs.get()
        try:
            job["result"] = act(job["body"])
        except (ValueError, PlaywrightError) as err:
            job["error"] = str(err).splitlines()[0][:300]
        except Exception as err:  # przeglądarka nie może paść przez jedną stronę
            job["error"] = f"{type(err).__name__}: {str(err)[:200]}"
        job["done"].set()
