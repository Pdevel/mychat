"""Zdalny ekran Szukajki: działa na maszynie InstaBox. Trzyma prawdziwą przeglądarkę (Chromium przez Playwright)
z osobną kartą dla każdego telefonu, wykonuje akcje (otwórz, kliknij, przewiń, wpisz, klawisz, wstecz…) i odsyła
zrzut ekranu z tytułem i adresem. Telefon dostaje tylko obrazek – JavaScript działa tutaj.

Uruchomienie: EKRAN_TOKEN=… python server.py  (port EKRAN_PORT, domyślnie 8765). Każde żądanie poza /health musi mieć
nagłówek X-Ekran-Token równy EKRAN_TOKEN.
"""
import base64
import hmac
import json
import os
import shutil
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

TOKEN = os.environ["EKRAN_TOKEN"]
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
            page.goto(url, wait_until="domcontentloaded", timeout=25000)
        except PlaywrightError as err:
            if "Timeout" not in str(err):
                raise
        settle(page, 1200)
    elif action == "click":
        x = max(0, min(WIDTH - 1, float(body.get("x", 0))))
        y = max(0, min(HEIGHT - 1, float(body.get("y", 0))))
        page.mouse.click(x, y)
        settle(page)
    elif action == "scroll":
        page.mouse.move(WIDTH / 2, HEIGHT / 2)
        page.mouse.wheel(0, max(-3000, min(3000, int(body.get("dy", 0)))))
        page.wait_for_timeout(400)
    elif action == "type":
        text = str(body.get("text") or "")[:500]
        if text:
            page.keyboard.type(text, delay=10)
        if body.get("enter"):
            page.keyboard.press("Enter")
        settle(page)
    elif action == "key":
        key = str(body.get("key") or "")
        if key not in KEYS:
            raise ValueError("nieznany klawisz")
        page.keyboard.press(" " if key == "Space" else key)
        settle(page, 400)
    elif action == "back":
        page.go_back(wait_until="domcontentloaded", timeout=15000)
        settle(page)
    elif action == "forward":
        page.go_forward(wait_until="domcontentloaded", timeout=15000)
        settle(page)
    elif action == "reload":
        page.reload(wait_until="domcontentloaded", timeout=20000)
        settle(page)
    elif action == "close":
        session = sessions.pop(sid, None)
        if session:
            session["context"].close()
        return {"closed": True}
    elif action != "shot":
        raise ValueError("nieznana akcja")
    shot = page.screenshot(type="jpeg", quality=60, timeout=15000)
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
            self.reply(200, {"ok": True, "sessions": len(sessions), "chromium": browser.version})
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
