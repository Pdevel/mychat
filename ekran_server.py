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
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import quote, urlparse

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

TOKEN = os.environ["EKRAN_TOKEN"]
with open(__file__, "rb") as _source:
    VERSION = hashlib.sha256(_source.read()).hexdigest()[:12]  # Szukajka wgrywa nową wersję, gdy ta się różni
PORT = int(os.environ.get("EKRAN_PORT", "8765"))
WIDTH, HEIGHT = 360, 560  # widok telefonu; Szukajka zmniejsza zrzut do szerokości ekranu Nokii
MAX_SESSIONS = 3
IDLE_SECONDS = 20 * 60
KEYS = {"Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown",
        "Home", "End", "Space"}

playwright = sync_playwright().start()
executable = next((p for p in (shutil.which("chromium"), shutil.which("chromium-browser"), shutil.which("google-chrome"))
                   if p), None)
browser = playwright.chromium.launch(executable_path=executable, args=["--no-sandbox", "--disable-dev-shm-usage"])
version = browser.version.split(".")[0]
USER_AGENT = (f"Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) "
              f"Chrome/{version}.0.0.0 Mobile Safari/537.36")  # widok mobilny, jak telefon z Chrome
sessions = {}
# Przed wpisaniem: kursor w polu tekstowym – aktywnym, klikniętym (albo jego wnętrzu/otoczeniu) lub pierwszym widocznym.
FOCUS = """([x, y]) => {
  const editable = e => !!e && (e.isContentEditable || (/^(INPUT|TEXTAREA)$/.test(e.tagName)
                                && !/^(hidden|button|submit|checkbox|radio|image|file|range|color)$/i.test(e.type || '')));
  if (editable(document.activeElement)) return 'active';
  const sel = 'input,textarea,[contenteditable=""],[contenteditable="true"]';
  const shown = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; };
  let e = x === null ? null : document.elementFromPoint(x, y);
  if (e && !editable(e)) e = e.closest(sel) || e.querySelector(sel) || (e.parentElement && e.parentElement.querySelector(sel));
  if (!editable(e) || !shown(e)) e = [...document.querySelectorAll(sel)].find(v => editable(v) && shown(v));
  if (!e) return 'none';
  e.focus();
  return editable(document.activeElement) ? 'focused' : 'none';
}"""
# „Czy kliknięcie coś zmieniło”: adres, liczba elementów, widoczny tekst (pokazane/schowane menu), fokus, przewinięcie.
ACTIVE = ("() => { const e = document.activeElement; if (!e) return ''; "
          "return e.tagName + '#' + e.id + '.' + String(e.className).slice(0, 40) + ' v=' + String(e.value || e.innerText || '').slice(0, 40)"
          " + ' ' + JSON.stringify(e.getBoundingClientRect()); }")
VALUE = "() => { const e = document.activeElement; return e ? String(e.value !== undefined ? e.value : e.innerText) : ''; }"
SET_VALUE = """(text) => {
  const e = document.activeElement;
  if (!e) return;
  if (e.isContentEditable) { e.innerText += text; }
  else {
    const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, (e.value || '') + text);
  }
  e.dispatchEvent(new InputEvent('input', {bubbles: true, data: text, inputType: 'insertText'}));
  e.dispatchEvent(new Event('change', {bubbles: true}));
}"""
SUBMIT = """() => {
  const e = document.activeElement;
  if (!e) return;
  if (e.form) { e.form.requestSubmit ? e.form.requestSubmit() : e.form.submit(); return; }
  for (const type of ['keydown', 'keypress', 'keyup'])
    e.dispatchEvent(new KeyboardEvent(type, {key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true}));
}"""
SIGNATURE = ("() => location.href + '|' + document.getElementsByTagName('*').length + '|' + "
             "(document.body ? document.body.innerText.length : 0) + '|' + "
             "(document.activeElement ? document.activeElement.tagName : '') + '|' + scrollY")


def page_for(sid):
    now = time.time()
    for old in [s for s, v in sessions.items() if now - v["used"] > IDLE_SECONDS]:
        sessions.pop(old)["context"].close()
    if sid not in sessions:
        while len(sessions) >= MAX_SESSIONS:
            oldest = min(sessions, key=lambda s: sessions[s]["used"])
            sessions.pop(oldest)["context"].close()
        context = browser.new_context(viewport={"width": WIDTH, "height": HEIGHT}, device_scale_factor=1, is_mobile=True,
                                      has_touch=True, user_agent=USER_AGENT, locale="pl-PL", timezone_id="Europe/Warsaw")
        sessions[sid] = {"context": context, "page": context.new_page(), "used": now}
    session = sessions[sid]
    session["used"] = now
    if session["page"].is_closed():
        session["page"] = session["context"].new_page()
    return session["page"]


def settle(page, wait=700):
    try:
        page.wait_for_load_state("domcontentloaded", timeout=4000)
    except PlaywrightError:
        pass
    page.wait_for_timeout(wait)


def press_enter(page):
    """Enter; gdy strona go zignoruje (Mapy Google odrzucają symulowane klawisze) – wysłanie formularza pola
    albo zdarzenie Enter wysłane z poziomu strony."""
    before = page.evaluate(SIGNATURE)
    page.keyboard.press("Enter")
    page.wait_for_timeout(700)
    if page.evaluate(SIGNATURE) == before:
        page.evaluate(SUBMIT)
        page.wait_for_timeout(500)
    return page.evaluate(SIGNATURE) != before


def act(body):
    sid = str(body.get("sid") or "")[:40]
    if not sid:
        raise ValueError("brak sid")
    page = page_for(sid)
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
        x = max(0, min(WIDTH - 1, float(body.get("x", 0))))
        y = max(0, min(HEIGHT - 1, float(body.get("y", 0))))
        before = page.evaluate(SIGNATURE)
        sessions[sid]["last"] = [x, y]
        page.mouse.click(x, y)
        page.wait_for_timeout(500)
        if page.evaluate(SIGNATURE) == before:  # nic się nie zmieniło: część stron mobilnych nie reaguje na mysz
            page.evaluate("([x, y]) => { const e = document.elementFromPoint(x, y); if (e) e.click(); }", [x, y])
        settle(page)
    elif action == "scroll":
        page.mouse.move(WIDTH / 2, HEIGHT / 2)
        page.mouse.wheel(0, max(-3000, min(3000, int(body.get("dy", 0)))))
        page.wait_for_timeout(400)
    elif action == "type":
        text = str(body.get("text") or "")[:500]
        target = page.evaluate(FOCUS, sessions[sid].get("last") or [None, None])
        if target == "none":
            raise ValueError("Nie widzę pola do wpisania tekstu – kliknij najpierw w pole na obrazie.")
        if text:
            page.keyboard.type(text, delay=15)
            if text not in page.evaluate(VALUE):  # pole odrzuca symulowane klawisze (np. Mapy Google)
                page.keyboard.insert_text(text)  # jak klawiatura ekranowa telefonu
            if text not in page.evaluate(VALUE):
                page.evaluate(SET_VALUE, text)  # wartość + zdarzenie „input” (pola sterowane przez React i podobne)
        debug = {"target": target, "frames": len(page.frames), "active": page.evaluate(ACTIVE)}
        if body.get("enter"):
            query = page.evaluate(VALUE).strip()
            if not press_enter(page) and query and re.match(r"https://www\.google\.[a-z.]+/maps", page.url):
                # Mapy Google przyjmują tylko „prawdziwy” Enter – ten sam wynik daje adres wyszukiwania
                page.goto("https://www.google.com/maps/search/" + quote(query), wait_until="domcontentloaded", timeout=12000)
            settle(page, 2000)  # wyniki wyszukiwania (np. Mapy Google) ładują się chwilę
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
                page.go_back(wait_until="domcontentloaded", timeout=10000)
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
    shot = page.screenshot(type="jpeg", quality=60, timeout=6000)
    if action == "type":
        return {"debug": debug, "title": page.title()[:200], "url": page.url, "width": WIDTH, "height": HEIGHT,
                "shot": base64.b64encode(shot).decode()}
    return {"title": page.title()[:200], "url": page.url, "width": WIDTH, "height": HEIGHT,
            "shot": base64.b64encode(shot).decode()}


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
        if self.path == "/health":
            self.reply(200, {"ok": True, "sessions": len(sessions), "chromium": browser.version, "version": VERSION})
        else:
            self.reply(404, {"error": "nie ma"})

    def do_POST(self):
        if self.path != "/act" or not hmac.compare_digest(self.headers.get("X-Ekran-Token", ""), TOKEN):
            self.reply(403, {"error": "brak dostępu"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > 20000:
            self.reply(413, {"error": "za duże"})
            return
        try:
            self.reply(200, act(json.loads(self.rfile.read(length) or b"{}")))
        except (ValueError, PlaywrightError) as err:
            self.reply(400, {"error": str(err).splitlines()[0][:300]})


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()  # jeden wątek: Playwright (sync) nie lubi wielu wątków
