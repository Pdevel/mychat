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
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, urlparse

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
    return {"w": num("w", 240, 480, WIDTH), "h": num("h", 320, 900, HEIGHT), "scale": num("scale", 1, 2, 1), "q": num("q", 40, 85, 60)}
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
# Klikalne elementy widoczne na ekranie (linki, przyciski, pola): telefon z klawiaturą skacze po nich strzałkami.
CLICKABLES = """() => {
  const sel = 'a[href],button,input:not([type=hidden]),textarea,select,summary,label[for],[role=button],[role=link],'
            + '[role=tab],[role=menuitem],[role=option],[role=checkbox],[onclick],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
  const out = [];
  for (const e of document.querySelectorAll(sel)) {
    const r = e.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
    const st = getComputedStyle(e);
    if (st.visibility === 'hidden' || +st.opacity === 0 || st.pointerEvents === 'none') continue;
    // link zawinięty na kilka linii: środek całego prostokąta wypada obok tekstu – klikamy w pierwszą widoczną linię
    const lines = [...e.getClientRects()].filter(q => q.width >= 4 && q.height >= 4 && q.bottom > 0 && q.top < innerHeight
                                                      && q.right > 0 && q.left < innerWidth);
    const q = lines[0] || r;
    const cx = Math.min(Math.max(q.left + q.width / 2, 1), innerWidth - 2), cy = Math.min(Math.max(q.top + q.height / 2, 1), innerHeight - 2);
    const top = document.elementFromPoint(cx, cy);
    if (!top || !(top === e || e.contains(top) || top.contains(e))) continue;  // zasłonięte (np. okienkiem)
    if (out.some(o => o.el.contains(e) || e.contains(o.el))) continue;  // link w przycisku itp. – raz
    const field = /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) && !/^(button|submit|reset|checkbox|radio|image|file|range|color)$/i.test(e.type || '')
                  || e.isContentEditable;
    const text = (e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('title') || e.getAttribute('placeholder')
                  || (e.querySelector('img[alt]') || {}).alt || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
    out.push({el: e, x: Math.max(0, r.left), y: Math.max(0, r.top), r: Math.min(r.right, innerWidth), b: Math.min(r.bottom, innerHeight),
              cx: Math.round(cx), cy: Math.round(cy), t: text, f: field ? 1 : 0});
    if (out.length >= 80) break;
  }
  return out.map(o => ({x: Math.round(o.x), y: Math.round(o.y), r: Math.round(o.r), b: Math.round(o.b), cx: o.cx, cy: o.cy, t: o.t, f: o.f}));
}"""
FIELD = """() => {
  const e = document.activeElement;
  const ok = e && (e.isContentEditable || (/^(INPUT|TEXTAREA)$/.test(e.tagName)
                   && !/^(hidden|button|submit|checkbox|radio|image|file|range|color)$/i.test(e.type || '')));
  return ok ? (e.getAttribute('aria-label') || e.placeholder || e.name || e.title || 'pole').slice(0, 60) : '';
}"""
# Czy kliknięty element to wyszukiwarka (lupa, „Szukaj”): wtedy chwilę czekamy, aż otworzy się jej pole.
SEARCHY = """([x, y]) => {
  let e = document.elementFromPoint(x, y);
  for (let i = 0; e && i < 4; i++, e = e.parentElement) {
    const text = [e.getAttribute('aria-label'), e.title, e.className && String(e.className), e.getAttribute('href'),
                  e.id, (e.innerText || '').slice(0, 30)].join(' ');
    if (/szuk|search|wyszuk|lupa|find/i.test(text)) return true;
  }
  return false;
}"""
SIGNATURE = ("() => location.href + '|' + document.getElementsByTagName('*').length + '|' + "
             "(document.body ? document.body.innerText.length : 0) + '|' + "
             "(document.activeElement ? document.activeElement.tagName : '') + '|' + scrollY")


def new_context(sid, view):
    context = browser.new_context(viewport={"width": view["w"], "height": view["h"]}, device_scale_factor=view["scale"],
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


def act(body):
    sid = str(body.get("sid") or "")[:40]
    if not sid:
        raise ValueError("brak sid")
    geo = body.get("geo")
    if not (isinstance(geo, dict) and all(isinstance(geo.get(k), (int, float)) for k in ("latitude", "longitude"))):
        geo = None
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
        x = max(0, min(width - 1, float(body.get("x", 0))))
        y = max(0, min(height - 1, float(body.get("y", 0))))
        before, url_before = run(page, SIGNATURE, default='nawigacja'), page.url
        sessions[sid]["last"] = [x, y]
        sessions[sid]["search_click"] = bool(run(page, SEARCHY, [x, y], default=False))
        page.mouse.click(x, y)
        page.wait_for_timeout(350)
        if run(page, SIGNATURE, default='nawigacja') == before:  # nic się nie zmieniło: część stron mobilnych nie reaguje na mysz
            run(page, "([x, y]) => { const e = document.elementFromPoint(x, y); if (e) e.click(); }", [x, y])
            page.wait_for_timeout(300)
        if page.url != url_before or run(page, "() => document.readyState", default="loading") != "complete":
            settle(page, 700)  # kliknięcie otworzyło inną stronę – zrzut dopiero, gdy się wczyta
        else:
            page.wait_for_timeout(350)  # nakładka, menu, pole: animacja i kursor
    elif action == "scroll":
        page.mouse.move(width / 2, height / 2)
        page.mouse.wheel(0, max(-3000, min(3000, int(body.get("dy", 0)))))
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
    shot = page.screenshot(type="jpeg", quality=view["q"], timeout=8000)
    result = {"title": title_of(page), "url": page.url, "width": width, "height": height, "shot": base64.b64encode(shot).decode(),
              "items": run(page, CLICKABLES, default=[]) or []}
    if action == "click":
        result["field"] = run(page, FIELD, default="") or ""  # kliknięto pole tekstowe – telefon od razu pokaże wpisywanie
        if not result["field"] and sessions[sid].get("search_click"):  # nakładka wyszukiwania jeszcze się otwiera
            page.wait_for_timeout(600)
            result["field"] = run(page, FIELD, default="") or ""
            result["shot"] = base64.b64encode(page.screenshot(type="jpeg", quality=view["q"], timeout=8000)).decode()
    if action == "type":
        result["debug"] = debug
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
            self.reply(200, {"ok": True, "sessions": len(sessions), "chromium": CHROMIUM, "version": VERSION, "busy": jobs.qsize()})
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
