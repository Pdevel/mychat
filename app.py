"""Ultralekka wyszukiwarka i czytnik stron dla Opera Mini na telefonach z klawiaturą
(Nokia 235 4G / Nokia 3210 4G: ekran 2,8", brak dotyku, 64 MB RAM).

Strony to czysty HTML: bez CSS, bez JavaScriptu, z jak najmniejszą liczbą linków przed treścią,
żeby wygodnie przechodzić po nich samymi strzałkami.

  /        – formularz wyszukiwania
  /search  – wyniki z DuckDuckGo Lite (region polski), 10 na stronę. Gdy DuckDuckGo blokuje serwer (np. na Render.com),
             wyniki przychodzą przez FrogFind (frogfind.com – prosta nakładka na DuckDuckGo, bez klucza API);
             opcjonalnie jeszcze Brave Search API (klucz w zmiennej BRAVE_API_KEY)
  /read    – czytnik: pobiera stronę, zostawia sam tekst (tytuł, nagłówki, akapity) i dzieli go na strony
  /film    – filmy ze stron przekodowane dla telefonu (MP4 H.264 320×240 albo 3GP H.263 176×144)
"""

import hashlib
import io
import ipaddress
import json
import logging
import os
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unicodedata
import uuid
from collections import OrderedDict
from urllib.parse import parse_qs, quote, urljoin, urlparse

import requests
import urllib3.util.connection as urllib3_connection
from bs4 import BeautifulSoup
from flask import Flask, Response, abort, redirect, render_template, request, send_file, url_for
from jinja2 import DictLoader
from PIL import Image, ImageDraw, ImageOps

try:  # readability daje najlepszy wybór treści; bez niego działa prostsza metoda zapasowa
    from readability import Document
except Exception:  # pragma: no cover
    Document = None

# ---------- Ustawienia ----------
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
TIMEOUT = (6, 15)  # (połączenie, odczyt) w sekundach – razem z pobieraniem mieści się w limicie Gunicorna (40 s)
DOWNLOAD_DEADLINE = 15  # łączny czas pobierania treści jednej strony
MAX_PAGE_BYTES = 1_500_000  # więcej nie pobieramy (oszczędza pamięć serwera)
MAX_REDIRECTS = 5
MAX_URL_LENGTH = 2000
RESULTS_PER_PAGE = 10
FIND_PER_PAGE = 15  # trafień „Szukaj na tej stronie” na jeden ekran
FIND_MAX_HITS = 150
MAX_RESULT_PAGES = 30
SNIPPET_CHARS = 220
ARTICLE_PAGE_CHARS = int(os.environ.get("ARTICLE_PAGE_CHARS", "3000"))  # tyle tekstu na jedną stronę w telefonie
ARTICLE_MAX_CHARS = 150_000  # dłuższe artykuły są przycinane

# Obrazki dla Nokii 235 4G / 3210 4G (ekran 240×320, 64 MB RAM): serwer zmniejsza je do szerokości ekranu i zapisuje
# jako lekki JPEG (zwykle kilka–kilkanaście KB), więc telefon nie pobiera ani nie dekoduje wielkich plików.
IMAGE_MAX_WIDTH = int(os.environ.get("IMAGE_MAX_WIDTH", "220"))  # ekran 240 px minus marginesy Opera Mini
IMAGE_MAX_HEIGHT = int(os.environ.get("IMAGE_MAX_HEIGHT", "400"))  # wysokie grafiki też się zmieszczą
IMAGE_QUALITY = int(os.environ.get("IMAGE_QUALITY", "45"))  # JPEG: mały plik, wciąż czytelny na tym ekranie
IMAGE_MAX_BYTES = 4_000_000  # większych plików nie pobieramy
# Powiększenie (zdjęcie wybrane w czytniku, otwierane w nowej karcie): większe i ostrzejsze, ale nadal lekkie.
IMAGE_HQ_WIDTH = int(os.environ.get("IMAGE_HQ_WIDTH", "720"))
IMAGE_HQ_HEIGHT = 3000  # wysokie obrazki (np. strony komiksu) zostają czytelne
IMAGE_HQ_QUALITY = int(os.environ.get("IMAGE_HQ_QUALITY", "72"))
IMAGE_HQ_MAX_BYTES = 10_000_000
IMAGE_MIN_SIZE = 48  # mniejsze to ikonki, flagi i piksele śledzące – na ekranie 240 px to tylko szum
IMAGES_PER_ARTICLE = 12  # więcej obrazków to zbyt dużo danych i pracy dla telefonu i darmowego serwera
GALLERY_MAX = 60  # obrazków z galerii (np. strony komiksu, zdjęcia z relacji) na jedną stronę serwisu
IMAGE_WEIGHT = 600  # obrazek zajmuje na stronie czytnika tyle „znaków” z limitu ARTICLE_PAGE_CHARS
# Miniatury na stronach z listą artykułów (np. główna serwisu): mniejsze i lżejsze niż zdjęcia w artykule.
THUMB_MAX_SIZE = int(os.environ.get("THUMB_MAX_SIZE", "80"))  # najdłuższy bok miniatury w px (stoi obok tytułu)
THUMBS_PER_LISTING = 30
THUMB_WEIGHT = 300  # ok. 10 miniatur na jedną stronę czytnika
Image.MAX_IMAGE_PIXELS = 25_000_000  # ochrona przed „bombami” (ogromne wymiary w małym pliku)

# Filmy: serwer pobiera plik (albo strumień HLS .m3u8), przekodowuje go ffmpegiem do małego pliku, który odtwarzacz
# wideo Nokii 235 4G / 3210 4G udźwignie, i podaje go do pobrania. Długie filmy dzielimy na części.
VIDEO_DIR = os.environ.get("VIDEO_DIR") or os.path.join(tempfile.gettempdir(), "szukajka-filmy")
VIDEO_PART_SECONDS = int(os.environ.get("VIDEO_PART_MINUTES", "15")) * 60  # długość jednej części filmu
VIDEO_MAX_PARTS = 20
VIDEO_SOURCE_MAX_BYTES = int(os.environ.get("VIDEO_SOURCE_MAX_MB", "400")) * 1_000_000  # większych plików nie pobieramy
VIDEO_DOWNLOAD_DEADLINE = 600  # s na pobranie źródła
VIDEO_CONVERT_DEADLINE = int(os.environ.get("VIDEO_CONVERT_MINUTES", "40")) * 60  # dłużej ffmpeg nie pracuje
VIDEO_JOBS = int(os.environ.get("VIDEO_JOBS", "1"))  # ile filmów naraz przygotowuje serwer (darmowy Render: 1)
VIDEO_KEEP_SECONDS = 3 * 3600  # gotowe pliki trzymamy tyle czasu
VIDEO_DISK_LIMIT = int(os.environ.get("VIDEO_DISK_MB", "1500")) * 1_000_000
VIDEO_STALE = 180  # zadanie bez znaku życia przez tyle sekund uznajemy za przerwane (np. restart serwera)
VIDEOS_PER_ARTICLE = 5
VIDEO_POSTER_SIZE = (IMAGE_MAX_WIDTH, 180)  # miniatura filmu na całą szerokość ekranu

DDG_LITE = "https://lite.duckduckgo.com/lite/"
DDG_HTML = "https://html.duckduckgo.com/html/"
DDG_REGION = "pl-pl"
FROGFIND = "http://frogfind.com/"  # serwis działa tylko po http
FROGFIND_UA = "LekkaSzukajka/1.0 (+https://github.com/Pdevel/mychat)"  # przedstawiamy się uczciwie
BRAVE_API = "https://api.search.brave.com/res/v1/web/search"
BRAVE_API_KEY = os.environ.get("BRAVE_API_KEY", "").strip()  # opcjonalny (darmowy plan); bez niego tylko DuckDuckGo
DDG_BACKOFF = 600  # po nieudanej próbie DuckDuckGo przez tyle sekund pytamy od razu źródło zapasowe (bez czekania)
ddg_down_until = 0.0


# Tylko IPv4: na serwerach bez działającego IPv6 połączenie z adresem IPv6 wisi aż do limitu czasu, a duże serwisy
# (np. za Cloudflare) podają oba rodzaje adresów. Prawie każda strona działa przez IPv4. FORCE_IPV4=0 wyłącza.
FORCE_IPV4 = os.environ.get("FORCE_IPV4", "1") != "0"
if FORCE_IPV4:
    urllib3_connection.HAS_IPV6 = False  # urllib3 (requests) pyta wtedy DNS tylko o adresy IPv4

# Błędy pobierania trafiają do logów (na Render: zakładka Logs), żeby było widać, która strona i dlaczego zawiodła.
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("szukajka")


class FetchError(Exception):
    """Błąd z komunikatem dla użytkownika (po polsku) i kodem HTTP odpowiedzi."""

    def __init__(self, message, status=502, blocked=False):
        super().__init__(message)
        self.message = message
        self.status = status
        self.blocked = blocked  # strona blokuje serwer Szukajki – pomoże otwarcie wprost w Operze


BLOCKED_MESSAGE = "Ta strona blokuje serwer Szukajki (ochrona przed botami). Otwórz ją bezpośrednio w Operze – często działa."
CHALLENGE_TITLE = re.compile(r"<title>\s*(Just a moment|Attention Required|Access denied|Checking your browser|DDoS-Guard)", re.I)


def is_blocked(resp):
    """Odmowa dostępu dla serwera: 401/403/429 albo ekran sprawdzania przeglądarki (np. Cloudflare)."""
    if resp.status_code in (401, 403, 429):
        return True
    return resp.status_code == 503 and (
        "challenge" in resp.headers.get("cf-mitigated", "").lower() or "cloudflare" in resp.headers.get("Server", "").lower()
    )


class TTLCache:
    """Mała pamięć podręczna w RAM (najstarsze wpisy wypadają), żeby nie pobierać tego samego przy zmianie strony."""

    def __init__(self, maxsize, ttl):
        self.maxsize = maxsize
        self.ttl = ttl
        self._data = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            item = self._data.get(key)
            if item is None:
                return None
            if item[0] < time.monotonic():
                del self._data[key]
                return None
            self._data.move_to_end(key)
            return item[1]

    def set(self, key, value):
        with self._lock:
            self._data[key] = (time.monotonic() + self.ttl, value)
            self._data.move_to_end(key)
            while len(self._data) > self.maxsize:
                self._data.popitem(last=False)


search_cache = TTLCache(maxsize=100, ttl=300)
article_cache = TTLCache(maxsize=20, ttl=900)
image_cache = TTLCache(maxsize=80, ttl=1800)  # gotowe, zmniejszone JPEG-i (ok. 10 KB każdy)


# ---------- Pobieranie stron (z ochroną przed adresami wewnętrznymi) ----------
def check_public_url(url):
    """Przepuszcza tylko http(s) do publicznych adresów IP – serwer nie może sięgać do sieci wewnętrznej."""
    parts = urlparse(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise FetchError("Nieprawidłowy adres strony.", 400)
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError:
        raise FetchError("Nieprawidłowy adres strony.", 400)
    try:
        family = socket.AF_INET if FORCE_IPV4 else socket.AF_UNSPEC  # sprawdzamy te same adresy, z którymi się połączymy
        infos = socket.getaddrinfo(parts.hostname, port, family, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError):
        raise FetchError("Nie znaleziono serwera tej strony. Sprawdź adres.", 502)
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if not ip.is_global or ip.is_multicast:
            raise FetchError("Ten adres jest niedostępny.", 400)


def http_request(url, method="GET", data=None, params=None, extra_headers=None):
    """Wysyła żądanie, ręcznie podąża za przekierowaniami (każde sprawdzamy) i zwraca (końcowy adres, odpowiedź)."""
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.5",
    }
    headers.update(extra_headers or {})
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        check_public_url(current)
        try:
            resp = requests.request(
                method, current, data=data, params=params, headers=headers, timeout=TIMEOUT, stream=True,
                allow_redirects=False,
            )
        except requests.exceptions.ConnectTimeout:
            log.warning("timeout połączenia: %s", current)
            raise FetchError("Nie udało się połączyć ze stroną na czas (serwer strony milczy). Spróbuj ponownie.", 504)
        except requests.exceptions.ReadTimeout:
            log.warning("timeout odpowiedzi: %s", current)
            raise FetchError("Strona za długo nie odpowiada. Spróbuj ponownie albo otwórz [Oryginał].", 504)
        except requests.exceptions.SSLError as err:
            log.warning("błąd SSL: %s (%s)", current, err)
            raise FetchError("Błąd połączenia szyfrowanego (SSL) z tą stroną.", 502)
        except requests.exceptions.ConnectionError as err:
            log.warning("błąd połączenia: %s (%s)", current, err)
            raise FetchError("Nie udało się połączyć ze stroną.", 502)
        except requests.exceptions.RequestException as err:
            log.warning("błąd pobierania: %s (%s)", current, err)
            raise FetchError("Nie udało się pobrać strony.", 502)
        location = resp.headers.get("Location")
        if resp.status_code in (301, 302, 303, 307, 308) and location:
            resp.close()
            current = urljoin(current, location)
            params = None  # parametry są już w adresie przekierowania
            if resp.status_code in (301, 302, 303):
                method, data = "GET", None
            continue
        return current, resp
    raise FetchError("Zbyt wiele przekierowań.", 502)


def read_body(resp, limit=MAX_PAGE_BYTES):
    """Czyta treść odpowiedzi najwyżej do `limit` bajtów i do DOWNLOAD_DEADLINE sekund."""
    started = time.monotonic()
    chunks, size = [], 0
    try:
        for chunk in resp.iter_content(16384):
            chunks.append(chunk)
            size += len(chunk)
            if size >= limit or time.monotonic() - started > DOWNLOAD_DEADLINE:
                break
    except requests.exceptions.RequestException:
        if not chunks:
            raise FetchError("Połączenie zostało przerwane podczas pobierania strony.", 502)
    finally:
        resp.close()
    return b"".join(chunks)[:limit]


META_CHARSET = re.compile(rb"""<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9_\-]+)""", re.I)


def decode_html(raw, resp):
    """Zamienia bajty na tekst: kodowanie z nagłówka, z <meta>, potem UTF-8, potem wykrywanie (cp1250, iso-8859-2…)."""
    candidates = []
    match = re.search(r"charset=([\w\-]+)", resp.headers.get("Content-Type", ""), re.I)
    if match:
        candidates.append(match.group(1))
    match = META_CHARSET.search(raw[:8192])
    if match:
        candidates.append(match.group(1).decode("ascii", "ignore"))
    for enc in candidates:
        try:
            return raw.decode(enc)
        except (LookupError, UnicodeDecodeError):
            continue
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        pass
    try:
        from charset_normalizer import from_bytes

        best = from_bytes(raw[:200_000]).best()
        if best is not None and best.encoding:
            return raw.decode(best.encoding, errors="replace")
    except Exception:
        pass
    return raw.decode("cp1250", errors="replace")  # częste na starszych polskich stronach


# ---------- Pomocnicze ----------
def squash(text):
    return " ".join((text or "").split())


def node_text(node):
    return squash(node.get_text(" ", strip=True)) if node is not None else ""


def shorten(text, limit):
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0]
    return cut.rstrip(" ,.;:-") + "…"


def clamp_int(value, default, low, high):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


def host_of(url):
    host = urlparse(url).hostname or ""
    return host[4:] if host.startswith("www.") else host


# ---------- Wyszukiwanie (DuckDuckGo Lite, region polski) ----------
def clean_result_url(href):
    """Odkodowuje przekierowania DuckDuckGo (/l/?uddg=…) i odrzuca reklamy oraz linki wewnętrzne."""
    if not href:
        return None
    if href.startswith("//"):
        href = "https:" + href
    parts = urlparse(href)
    if parts.netloc.endswith("duckduckgo.com") and parts.path.startswith("/l/"):
        href = (parse_qs(parts.query).get("uddg") or [None])[0]
        if not href:
            return None
        parts = urlparse(href)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None
    if parts.netloc.endswith("duckduckgo.com"):  # reklamy (y.js) i strony DuckDuckGo
        return None
    return href


def parse_ddg_lite(html):
    """Wyniki z lite.duckduckgo.com: linki a.result-link, a pod nimi komórki td.result-snippet."""
    soup = BeautifulSoup(html, "lxml")
    results, current = [], None
    for node in soup.find_all(["a", "td"]):
        classes = node.get("class") or []
        if node.name == "a" and "result-link" in classes:
            row = node.find_parent("tr")
            if row is not None and "result-sponsored" in (row.get("class") or []):
                current = None
                continue
            url = clean_result_url(node.get("href"))
            if not url:
                current = None
                continue
            current = {"title": node_text(node) or url, "url": url, "snippet": ""}
            results.append(current)
        elif current is not None and "result-snippet" in classes and not current["snippet"]:
            current["snippet"] = shorten(node_text(node), SNIPPET_CHARS)
    return results


def parse_ddg_html(html):
    """Zapasowo: wyniki z html.duckduckgo.com (div.result z a.result__a i .result__snippet)."""
    soup = BeautifulSoup(html, "lxml")
    results = []
    for block in soup.select("div.result"):
        if "result--ad" in (block.get("class") or []):
            continue
        link = block.select_one("a.result__a")
        url = clean_result_url(link.get("href")) if link is not None else None
        if not url:
            continue
        snippet = block.select_one(".result__snippet")
        results.append(
            {"title": node_text(link) or url, "url": url, "snippet": shorten(node_text(snippet), SNIPPET_CHARS)}
        )
    return results


def frogfind_target(href):
    """Adres docelowy z linku FrogFind: /read?a=ADRES&k=…, /read.php?a=ADRES, //duckduckgo.com/l/?uddg=ADRES
    albo bezpośredni adres. Zwraca None dla linków wewnętrznych (np. logo „/”) i reklam."""
    href = (href or "").strip()
    parts = urlparse(href)
    if parts.path.rstrip("/").endswith(("/read", "read.php")):
        href = (parse_qs(parts.query).get("a") or [""])[0]
    return clean_result_url(href)


def parse_frogfind(html):
    """Wyniki z frogfind.com. Jeden wynik to zwykle dwa linki z tym samym adresem (tytuł i wyświetlany adres),
    a za ostatnim z nich opis aż do <hr>. Tytuł bierzemy z pierwszego linku, który nie jest samym adresem."""
    soup = BeautifulSoup(html, "lxml")
    found = OrderedDict()
    for link in soup.find_all("a", href=True):
        url = frogfind_target(link["href"])
        if not url:
            continue
        item = found.setdefault(url, {"title": "", "url": url, "snippet": ""})
        bold = link.find("b")
        text = node_text(bold) if bold is not None else node_text(link)
        if text and not item["title"] and not re.match(r"^(https?://|www\.)", text, re.I):
            item["title"] = text
        parts = []
        for sibling in link.next_siblings:
            if getattr(sibling, "name", None) in ("hr", "a"):
                break
            parts.append(sibling.get_text() if hasattr(sibling, "get_text") else str(sibling))
        snippet = squash("".join(parts))
        if len(snippet) > len(item["snippet"]):
            item["snippet"] = shorten(snippet, SNIPPET_CHARS)
    results = list(found.values())
    for item in results:
        item["title"] = item["title"] or item["url"]
    return results


def frogfind_search(query, page):
    """FrogFind pobiera wyniki DuckDuckGo ze swojego serwera, którego DuckDuckGo nie blokuje. Ma tylko 1 stronę wyników."""
    if page > 1:
        return [], False
    _, resp = http_request(FROGFIND, params={"q": query}, extra_headers={"User-Agent": FROGFIND_UA})
    status = resp.status_code
    html = decode_html(read_body(resp, limit=800_000), resp)
    if status != 200:
        log.warning("FrogFind zwrócił status %s", status)
        raise FetchError("Zapasowa wyszukiwarka (FrogFind) nie odpowiada. Spróbuj za chwilę.", 502)
    results = dedupe(parse_frogfind(html))
    if not results:
        # Pusta lista od FrogFind to prawie zawsze awaria po jego stronie (DuckDuckGo blokuje także jego serwer)
        # albo zmiana wyglądu strony – nie udajemy, że naprawdę nic nie znaleziono.
        log.warning("FrogFind: 0 wyników (%d B, linków read: %d): %s", len(html), html.count("read?a="),
                    squash(BeautifulSoup(html, "lxml").get_text(" "))[:300])
        raise FetchError("Zapasowa wyszukiwarka (FrogFind) nie zwróciła wyników – pewnie chwilowo nie działa. "
                         "Spróbuj za kilka minut.", 502)
    return results[:RESULTS_PER_PAGE], False


def parse_brave(data):
    """Wyniki z Brave Search API (JSON): web.results[] z polami title, url, description (z <strong>)."""
    results = []
    for item in ((data or {}).get("web") or {}).get("results") or []:
        url = clean_result_url(item.get("url"))
        if not url:
            continue
        title = squash(BeautifulSoup(item.get("title") or "", "lxml").get_text(" ")) or url
        snippet = squash(BeautifulSoup(item.get("description") or "", "lxml").get_text(" "))
        results.append({"title": title, "url": url, "snippet": shorten(snippet, SNIPPET_CHARS)})
    return results


def brave_search(query, page):
    """Oficjalne API Brave (darmowy plan z kluczem) – działa także z serwerów, które DuckDuckGo blokuje."""
    params = {
        "q": query, "country": "PL", "search_lang": "pl", "count": str(RESULTS_PER_PAGE),
        "offset": str(min(page - 1, 9)), "safesearch": "moderate",
    }
    _, resp = http_request(
        BRAVE_API, params=params,
        extra_headers={"Accept": "application/json", "X-Subscription-Token": BRAVE_API_KEY},
    )
    status = resp.status_code
    raw = read_body(resp, limit=800_000)
    if status in (401, 403, 422):
        raise FetchError("Zapasowa wyszukiwarka odrzuciła klucz API (sprawdź BRAVE_API_KEY).", 502)
    if status == 429:
        raise FetchError("Wyczerpany limit zapasowej wyszukiwarki. Spróbuj później.", 503)
    if status != 200:
        raise FetchError("Zapasowa wyszukiwarka nie odpowiada. Spróbuj ponownie.", 502)
    try:
        data = json.loads(raw.decode("utf-8", errors="replace"))
    except ValueError:
        raise FetchError("Nie udało się odczytać wyników wyszukiwania.", 502)
    results = dedupe(parse_brave(data))
    more = bool(((data.get("query") or {}).get("more_results_available"))) and page < 10
    return results[:RESULTS_PER_PAGE], more


def dedupe(results):
    seen, unique = set(), []
    for item in results:
        if item["url"] in seen:
            continue
        seen.add(item["url"])
        unique.append(item)
    return unique


def looks_blocked(html):
    return any(marker in html for marker in ("anomaly-modal", "challenge-form", "bots use DuckDuckGo too"))


def says_no_results(html):
    return re.search(r"No\s+(?:more\s+)?results", html, re.I) is not None


def ddg_search(query, page):
    """Zwraca (wyniki, czy_jest_następna_strona). Najpierw wersja Lite, w razie kłopotów wersja HTML, potem Brave."""
    global ddg_down_until
    key = (query.lower(), page)
    cached = search_cache.get(key)
    if cached is not None:
        return cached
    offset = (page - 1) * RESULTS_PER_PAGE
    form = {"q": query, "kl": DDG_REGION}
    if offset:
        form.update({"s": str(offset), "dc": str(offset + 1)})
    last_error = FetchError("Nie udało się pobrać wyników wyszukiwania. Spróbuj ponownie.", 502)
    unreachable = FetchError("Wyszukiwarka DuckDuckGo nie odpowiada z tego serwera.", 503)
    endpoints = ((DDG_LITE, parse_ddg_lite), (DDG_HTML, parse_ddg_html))
    if time.monotonic() < ddg_down_until:
        endpoints = ()  # DuckDuckGo niedawno zawiódł – od razu źródło zapasowe
    for endpoint, parser in endpoints:
        try:
            _, resp = http_request(endpoint, method="POST", data=form)
            status = resp.status_code
            html = decode_html(read_body(resp, limit=800_000), resp)
        except FetchError as err:
            last_error = unreachable if err.status in (502, 504) else err
            ddg_down_until = time.monotonic() + DDG_BACKOFF
            continue
        if status != 200 or looks_blocked(html):
            log.warning("DuckDuckGo odrzucił zapytanie (%s, status %s)", endpoint, status)
            ddg_down_until = time.monotonic() + DDG_BACKOFF
            last_error = FetchError(
                "Wyszukiwarka chwilowo nie przyjmuje zapytań z tego serwera. Spróbuj za kilka minut.", 503
            )
            continue
        results = dedupe(parser(html))
        if results or says_no_results(html):
            value = (results[:RESULTS_PER_PAGE], len(results) >= RESULTS_PER_PAGE and page < MAX_RESULT_PAGES)
            search_cache.set(key, value)
            return value
        last_error = FetchError("Nie udało się odczytać wyników wyszukiwania. Spróbuj ponownie.", 502)
    if page == 1 or not BRAVE_API_KEY:
        try:
            value = frogfind_search(query, page)
            search_cache.set(key, value)
            return value
        except FetchError as err:
            log.warning("FrogFind zawiódł: %s", err.message)
            if not BRAVE_API_KEY:
                raise err
    if BRAVE_API_KEY and page <= 10:
        value = brave_search(query, page)  # jej błąd (np. zły klucz) mówi więcej niż blokada DuckDuckGo
        search_cache.set(key, value)
        return value
    raise last_error


# ---------- Czytnik ----------
BLOCK_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "pre", "blockquote", "dd", "dt"]
CONTAINER_TAGS = {"p", "li", "pre", "blockquote", "dd", "dt"}
JUNK_TAGS = [
    "script", "style", "noscript", "template", "iframe", "object", "embed", "svg", "canvas",
    "video", "audio", "form", "button", "input", "select", "textarea",
    "nav", "header", "footer", "aside", "menu", "dialog",
]
IMG_PLACEHOLDER = re.compile(r"^data:|blank\.gif|spacer\.|pixel\.|1x1|transparent\.", re.I)
JUNK_HINT = re.compile(
    r"(^|[-_ ])(nav|menu|footer|header|sidebar|cookie|consent|banner|advert|ads?|promo|social|share|"
    r"related|newsletter|comment|popup|modal|breadcrumb)([-_ ]|$)",
    re.I,
)


def primary_link(node, base_url):
    """Adres, jeśli cały blok jest linkiem (np. tytuł artykułu na stronie głównej): blok leży w <a> albo jeden
    link zajmuje większość jego tekstu. Pojedyncze słowa-linki w akapicie pomijamy – mniej skakania strzałkami."""
    wrapper = node.find_parent("a", href=True)
    if wrapper is not None:
        candidates = [wrapper]
    else:
        total = len(node_text(node))
        candidates = [a for a in node.find_all("a", href=True) if total and len(node_text(a)) >= 0.6 * total]
    for link in candidates:
        href = urljoin(base_url, link["href"].strip())
        if urlparse(href).scheme not in ("http", "https"):
            continue  # javascript:, mailto:, tel: …
        if href.split("#")[0] == base_url.split("#")[0]:
            continue  # kotwica na tej samej stronie
        return href
    return None


def image_source(img, base_url, check_size=True):
    """Adres obrazka: src, a gdy to zaślepka – data-src/data-lazy-src/data-original albo srcset (także z <picture>)."""
    for attr in ("data-src", "data-lazy-src", "data-original", "src"):
        value = (img.get(attr) or "").strip()
        if value and not IMG_PLACEHOLDER.search(value):
            break
    else:
        value = ""
    if not value:
        sets = [img.get("data-srcset"), img.get("srcset")]
        picture = img.find_parent("picture")
        if picture is not None:
            sets += [source.get("srcset") or source.get("data-srcset") for source in picture.find_all("source")]
        for candidates in filter(None, sets):
            value = candidates.split(",")[0].strip().split(" ")[0]  # pierwszy wariant zwykle najmniejszy
            if value:
                break
    if not value:
        return None
    src = urljoin(base_url, value)
    parts = urlparse(src)
    if parts.scheme not in ("http", "https") or parts.path.lower().endswith(".svg"):
        return None
    if check_size and is_small_image(img):
        return None  # ikonka albo piksel śledzący
    return src


def is_small_image(img):
    """Czy znacznik <img> deklaruje wymiary mniejsze niż IMAGE_MIN_SIZE (ikonki, flagi, piksele śledzące)."""
    for attr in ("width", "height"):
        size = re.match(r"\d+", str(img.get(attr) or ""))
        if size and int(size.group()) < IMAGE_MIN_SIZE:
            return True
    return False


def letters(text):
    return sum(char.isalpha() for char in text)


def card_link(link, base_url):
    """Adres linku-kafelka albo None (javascript:, kotwica na tej samej stronie, plik graficzny z galerii)."""
    href = urljoin(base_url, link["href"].strip())
    if urlparse(href).scheme not in ("http", "https") or href.split("#")[0] == base_url.split("#")[0]:
        return None
    if IMAGE_FILE.search(urlparse(href).path):
        return None
    return href


def collect_blocks(root, base_url, with_images=False, skip_images=frozenset(), image_kind="img", max_images=IMAGES_PER_ARTICLE,
                   cards=False):
    """Zbiera z drzewa nagłówki i akapity w kolejności występowania, bez powtarzania zagnieżdżonych.
    Blok to (rodzaj, tekst, adres_linku_lub_None); ten sam adres linkujemy tylko raz.
    Z with_images=True dochodzą bloki (image_kind, opis, adres_obrazka) – najwyżej max_images
    ("img" – zdjęcie w artykule, "thumb" – miniatura na stronie z listą).
    cards=True (strony z listą): także „kafelki” – linki z obrazkiem i tytułem w zwykłym <div>/<span>, w title
    albo w alt obrazka (sklepy, katalogi, serwisy z przepisami…), które nie leżą w nagłówku ani akapicie."""
    blocks, linked, images = [], set(), set()
    consumed, card_hrefs, best_text = set(), set(), {}
    if cards:  # najlepszy tytuł dla adresu: kafelek bywa obrazkiem-linkiem, a tytuł osobnym linkiem obok
        for link in root.find_all("a", href=True):
            href = card_link(link, base_url)
            if href:
                for candidate in (node_text(link), squash(link.get("title") or "")):
                    if letters(candidate) > letters(best_text.get(href, "")):
                        best_text[href] = candidate  # tytuł ma najwięcej liter (nie „8,77 10 988 tys. ocen”)
    tags = BLOCK_TAGS + (["img"] if with_images else []) + (["a"] if cards else [])
    for node in root.find_all(tags):
        if node.name == "a":
            if node.get("href") is None or node.find(BLOCK_TAGS) is not None:
                continue  # tytuł w nagłówku/akapicie wewnątrz linku – obsłuży go zwykła ścieżka
            if any(parent.name in BLOCK_TAGS for parent in node.parents):
                continue
            href = card_link(node, base_url)
            if not href or href in linked:
                continue
            img = node.find("img")
            text = best_text.get(href) or squash(node.get("title") or "") or squash(img.get("alt") or "" if img else "")
            if not (len(text) >= 25 or len(text.split()) >= 4 or (img is not None and len(text) >= 2)):
                continue  # „Więcej”, „Zobacz”, numery stron…
            if img is not None:
                consumed.add(id(img))
                src = image_source(img, base_url) if with_images else None
                if src and src not in images and src not in skip_images and len(images) < max_images:
                    images.add(src)
                    blocks.append((image_kind, "", src))
            linked.add(href)
            card_hrefs.add(href)
            blocks.append(("p", shorten(text, 200), href))
            continue
        if node.name == "img":
            if id(node) in consumed:
                continue
            src = image_source(node, base_url)
            if src and src not in images and src not in skip_images and len(images) < max_images:
                images.add(src)
                blocks.append((image_kind, shorten(squash(node.get("alt") or ""), 80), src))
            continue
        if any(parent.name in CONTAINER_TAGS for parent in node.parents):
            continue  # np. <p> wewnątrz <li> – tekst trafi już z rodzica
        text = node_text(node)
        if not text:
            continue
        href = primary_link(node, base_url)
        if cards and node.name == "li" and node.find("img") is not None:
            # kafelek w <li> (obrazek + tytuł + cena): miniatura przed tytułem, tytuł z linku, reszta tekstu po kropce
            hrefs = [h for h in (card_link(a, base_url) for a in node.find_all("a", href=True)) if h]
            if hrefs:
                href = max(set(hrefs), key=hrefs.count)
                if href in linked:
                    continue
                rest = squash(" ".join(t for t in node.find_all(string=True) if t.find_parent("a") is None))
                title = best_text.get(href) or text
                text = title + (" · " + rest if rest and len(rest) < 80 else "")
                img = node.find("img")
                consumed.add(id(img))
                src = image_source(img, base_url) if with_images else None
                if src and src not in images and src not in skip_images and len(images) < max_images:
                    images.add(src)
                    blocks.append((image_kind, "", src))
                linked.add(href)
                card_hrefs.add(href)
                blocks.append(("p", "• " + text, href))
                continue
        if href in card_hrefs and len(text) < 200:
            continue  # tytuł kafelka już pokazany (np. <h3> pod obrazkiem-linkiem do tego samego adresu)
        if href in linked:
            href = None
        elif href:
            linked.add(href)
        if node.name in ("h1", "h2", "h3", "h4", "h5", "h6"):
            blocks.append(("h", text, href))
        elif node.name == "li":
            blocks.append(("p", "• " + text, href))
        else:
            blocks.append(("p", text, href))
    return blocks


def is_menu_entry(block):
    kind, text, href = block
    text = text[2:] if text.startswith("• ") else text
    return kind in ("p", "h") and href is not None and len(text) <= 25 and len(text.split()) <= 3


def drop_menus(blocks, run=6):
    """Usuwa menu nieoznaczone jako <nav>: ciąg co najmniej `run` krótkich linków z rzędu (np. „Filmy”, „Seriale”,
    „Rankingi”…) bez obrazków. Na telefonie z klawiaturą to dziesiątki skoków strzałką przed treścią."""
    def neutral(block):  # krótki podpis bez linku (np. „Na VOD”) nie przerywa menu
        return block[0] in ("p", "h") and block[2] is None and len(block[1]) <= 25

    out, i = [], 0
    while i < len(blocks):
        j, links = i, 0
        while j < len(blocks) and (is_menu_entry(blocks[j]) or (links and neutral(blocks[j]))):
            links += is_menu_entry(blocks[j])
            j += 1
        while j > i and not is_menu_entry(blocks[j - 1]):
            j -= 1  # podpis na końcu ciągu należy już do treści
        if links >= run:
            i = j  # menu – pomijamy cały ciąg
            continue
        out.extend(blocks[i:j] if j > i else blocks[i:i + 1])
        i = j if j > i else i + 1
    return out


def fallback_blocks(soup, base_url, skip_images=frozenset()):
    """Gdy readability zawiedzie: usuń śmieci (skrypty, menu, reklamy…) i weź tekst z <article>/<main>/<body>."""
    for tag in soup(JUNK_TAGS):
        tag.decompose()
    for tag in soup.find_all(True):
        if tag.attrs is None:
            continue
        # klasy BEM „blok__element” (np. card__header) to części kafelka, a nie nagłówek/stopka strony
        names = [c for c in (tag.get("class") or []) + [tag.get("id") or ""] if c and "__" not in c]
        hint = " ".join(names)
        if hint.strip() and JUNK_HINT.search(hint) and tag.name not in ("body", "html", "article", "main"):
            tag.decompose()
    articles = soup.find_all("article")
    if len(articles) == 1:
        root = articles[0]
    else:  # wiele <article> to zwykle kafelki listy – bierzemy ich wspólny kontener, a nie pierwszy kafelek
        root = soup.find("main") or soup.body or soup
    blocks = collect_blocks(
        root, base_url, with_images=True, skip_images=skip_images, image_kind="thumb", max_images=THUMBS_PER_LISTING,
        cards=True,
    )
    blocks = drop_menus(blocks)
    if not [b for b in blocks if b[0] != "thumb"]:  # strona bez akapitów – bierzemy linie tekstu
        blocks = [("p", line, None) for line in (squash(x) for x in root.get_text("\n").split("\n")) if len(line) > 1]
    return blocks


CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")  # przez nie readability (lxml) odmawia pracy


IMAGE_FILE = re.compile(r"\.(jpe?g|png|webp|gif)$", re.I)


def gallery_images(soup, base_url):
    """Galeria z powiększeniem: miniatura w linku do pełnego pliku graficznego. Zwraca [(pełny_obrazek, miniatura, opis)]."""
    found, seen = [], set()
    for link in soup.find_all("a", href=True):
        img = link.find("img")
        full = urljoin(base_url, link["href"].strip())
        path = urlparse(full).path
        if img is None or not IMAGE_FILE.search(path) or urlparse(full).scheme not in ("http", "https"):
            continue
        if ":" in path.rsplit("/", 1)[-1] or "/wiki/" in path:
            continue  # strona opisu pliku (MediaWiki: Plik:…jpg, File:…jpg), a nie sam obrazek
        if full in seen:
            continue
        seen.add(full)
        found.append((full, image_source(img, base_url, check_size=False), shorten(squash(img.get("alt") or ""), 80)))
        if len(found) >= GALLERY_MAX:
            break
    return found


def apply_gallery(blocks, gallery):
    """Obrazki z galerii: w treści podmieniamy miniatury na pełne obrazki, a brakujące (gdy galeria ma co najmniej
    3 obrazki – np. strony komiksu) dokładamy na końcu w sekcji „Galeria”."""
    by_thumb = {thumb: full for full, thumb, _ in gallery if thumb}
    shown = set()
    upgraded = []
    for kind, text, href in blocks:
        if kind in ("img", "thumb") and (href in by_thumb or href in {g[0] for g in gallery}):
            href = by_thumb.get(href, href)
            kind = "img"
            shown.add(href)
        upgraded.append((kind, text, href))
    missing = [g for g in gallery if g[0] not in shown]
    if len(gallery) >= 3 and missing:
        upgraded.append(("h", "Galeria", None))
        upgraded += [("img", alt, full) for full, _, alt in missing]
    return upgraded


# Listy w danych strony: nowoczesne strony (Next.js, Nuxt…) wysyłają zawartość list jako JSON w HTML, a wyświetla ją
# dopiero JavaScript. Szukamy w tych danych list obiektów z tytułem i adresem (np. {"title": …, "url": …, "image": …}).
JSON_TITLE_KEYS = ("title", "name", "headline", "label", "heading", "displayName", "originalTitle")
JSON_IMAGE_KEYS = ("image", "img", "thumbnail", "thumbnailUrl", "thumb", "photo", "picture", "poster", "cover",
                   "imageUrl", "image_url", "posterUrl", "coverUrl", "mainImage", "photos", "images")
JSON_URL_KEY = re.compile(r"url|link|href|path|permalink", re.I)
JSON_MAX_ITEMS = 200


def json_value_url(value, base_url, image=False):
    if isinstance(value, list):
        value = value[0] if value else None
    if isinstance(value, dict):
        value = value.get("url") or value.get("src") or value.get("link") or value.get("href")
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value.startswith(("http://", "https://", "/")) or len(value) > MAX_URL_LENGTH:
        return None
    full = urljoin(base_url, value)
    if urlparse(full).scheme not in ("http", "https"):
        return None
    is_image = IMAGE_FILE.search(urlparse(full).path) is not None
    if not image and is_image:
        return None
    return full


def json_item(obj, base_url):
    """(tytuł, adres, obrazek_albo_None) z obiektu JSON albo None."""
    if isinstance(obj.get("item"), dict):  # schema.org ListItem {"item": {...}}
        obj = dict(obj["item"], **{k: v for k, v in obj.items() if k != "item"})
    title = next((squash(obj[k]) for k in JSON_TITLE_KEYS if isinstance(obj.get(k), str) and 2 <= len(squash(obj[k])) <= 200), None)
    if not title:
        return None
    url = None
    for key, value in obj.items():
        if JSON_URL_KEY.search(key) and not any(word in key.lower() for word in ("image", "img", "thumb", "photo", "poster", "cover", "logo", "icon")):
            url = json_value_url(value, base_url)
            if url:
                break
    if not url:
        return None
    image = next((u for u in (json_value_url(obj.get(k), base_url, image=True) for k in JSON_IMAGE_KEYS) if u), None)
    return title, url, image


def json_listing(soup, base_url):
    """Pozycje list z danych JSON wbudowanych w stronę (__NEXT_DATA__, application/json, JSON-LD ItemList)."""
    found, seen = [], set()

    def walk(value, depth):
        if depth > 14 or len(found) >= JSON_MAX_ITEMS:
            return
        if isinstance(value, list):
            items = [json_item(v, base_url) for v in value[:300] if isinstance(v, dict)]
            items = [i for i in items if i]
            with_image = sum(1 for i in items if i[2])
            long_titles = sum(1 for i in items if len(i[0]) >= 25 or len(i[0].split()) >= 4)
            if len(items) >= 4 and (with_image * 2 >= len(items) or long_titles * 2 >= len(items)):  # nie menu/stopka
                for item in items:
                    if item[1] not in seen and item[1].split("#")[0] != base_url.split("#")[0]:
                        seen.add(item[1])
                        found.append(item)
            for v in value[:300]:
                walk(v, depth + 1)
        elif isinstance(value, dict):
            for v in value.values():
                walk(v, depth + 1)

    for script in soup.find_all("script", type=("application/json", "application/ld+json")):
        text = script.string or ""
        if not text.strip() or len(text) > 3_000_000:
            continue
        try:
            walk(json.loads(text), 0)
        except (ValueError, RecursionError):
            continue
    return found[:JSON_MAX_ITEMS]


def add_json_listing(blocks, embedded):
    """Dokłada pozycje z danych JSON, których nie było w HTML. Gdy jest ich więcej niż linków w HTML (lista
    wyświetlana dopiero przez JavaScript), idą na początek, w przeciwnym razie na koniec w sekcji „Więcej ze strony”."""
    linked = {b[2] for b in blocks if b[0] in ("h", "p") and b[2]}
    new = [item for item in embedded if item[1] not in linked]
    if len(new) < 4:
        return blocks
    thumbs = sum(1 for b in blocks if b[0] == "thumb")
    section = []
    for title, href, image in new:
        if image and thumbs < THUMBS_PER_LISTING:
            section.append(("thumb", "", image))
            thumbs += 1
        section.append(("p", title, href))
    if len(new) > len(linked):
        return section + blocks
    return blocks + [("h", "Więcej ze strony", None)] + section


def extract_article(html, url, videos=None, posters=None):
    """Zwraca (tytuł, bloki), gdzie blok to ("h" | "p", tekst, adres_linku_lub_None).
    Gdy podano listę `videos`, trafiają do niej adresy filmów ze strony."""
    html = CONTROL_CHARS.sub("", html)
    soup = BeautifulSoup(html, "lxml")
    title = node_text(soup.title) or host_of(url)
    gallery = gallery_images(soup, url)  # przed czyszczeniem – readability wycina galerie
    embedded = json_listing(soup, url)
    if videos is not None:
        videos.extend(find_videos(soup, url, posters=posters))  # przed czyszczeniem – readability usuwa znaczniki <video>
        lead = lead_image(soup, url)
        if posters is not None and lead:
            posters[""] = lead[0]  # zdjęcie strony – zapasowa miniatura filmu
    # readability usuwa z obrazków width/height – ikonki rozpoznajemy po wymiarach z oryginalnej strony
    small_images = {image_source(img, url, check_size=False) for img in soup.find_all("img") if is_small_image(img)}
    blocks = []
    if Document is not None:
        try:
            doc = Document(html, url=url)
            title = squash(doc.short_title()) or title
            blocks = collect_blocks(
                BeautifulSoup(doc.summary(html_partial=True), "lxml"), url, with_images=True, skip_images=small_images
            )
        except Exception as err:
            log.info("readability nie poradził sobie z %s: %s", url, str(err)[:120])
            blocks = []
    # Gdy readability znalazła mało tekstu, to zwykle strona z listą artykułów (np. główna serwisu): readability wycina
    # bloki gęste od linków, czyli właśnie tytuły. Wtedy bierzemy całą treść strony (bez menu i stopki) z tytułami-linkami.
    # Artykuły i Wikipedia mają w readability tysiące znaków – zostają przy niej (bez list „czytaj też”).
    # Strony z listą dostają małe miniatury (THUMB_MAX_SIZE), żeby dziesiątki obrazków nie przeciążyły telefonu.
    readability_chars = sum(len(b[1]) for b in blocks if b[0] != "img")
    # Strona główna serwisu to lista (nawet gdy wkleja kilka pełnych newsów, które readability bierze za artykuł).
    front_page = re.fullmatch(r"/?|/(home|index|start|main|default)(\.\w+)?/?", urlparse(url).path or "/", re.I) is not None
    listing = readability_chars < 1500
    if readability_chars < 1500 or front_page:
        fallback = fallback_blocks(soup, url, skip_images=small_images)
        fallback_links = sum(1 for b in fallback if b[0] in ("h", "p") and b[2])
        if sum(len(b[1]) for b in fallback if b[0] != "thumb") > readability_chars or (front_page and fallback_links >= 10):
            blocks = fallback
            listing = True
    if listing and embedded:  # tylko strony z listą – w artykułach dane JSON to zwykle „polecane”
        blocks = add_json_listing(blocks, embedded)
    if gallery:
        blocks = apply_gallery(blocks, gallery)
    if blocks and blocks[0][0] == "h" and blocks[0][1] == title:
        blocks = blocks[1:]  # tytuł pokazujemy osobno
    # Zdjęcie główne serwisów informacyjnych stoi zwykle w nagłówku, poza treścią wybraną przez readability.
    # Strony podają je w znaczniku og:image – dokładamy je na początek, gdy w treści artykułu nie ma żadnego obrazka.
    if blocks and blocks[0][2] is None and not any(b[0] in ("img", "thumb") for b in blocks) and readability_chars >= 1500:
        lead = lead_image(soup, url)
        if lead:
            blocks.insert(0, ("img", lead[1], lead[0]))
    return title, blocks


def lead_image(soup, base_url):
    """Zdjęcie główne strony z og:image / twitter:image: (adres, opis) albo None."""
    for attrs in ({"property": "og:image"}, {"name": "og:image"}, {"name": "twitter:image"}, {"property": "twitter:image"}):
        meta = soup.find("meta", attrs=attrs)
        if meta is not None and (meta.get("content") or "").strip():
            src = urljoin(base_url, meta["content"].strip())
            parts = urlparse(src)
            if parts.scheme in ("http", "https") and not parts.path.lower().endswith(".svg"):
                alt = soup.find("meta", attrs={"property": "og:image:alt"})
                return src, shorten(squash(alt.get("content") if alt is not None else ""), 80)
    return None


def split_long(text, limit):
    """Dzieli zbyt długi akapit na kawałki (najlepiej po zdaniach, inaczej po słowach)."""
    if len(text) <= limit:
        return [text]
    pieces, rest = [], text
    while len(rest) > limit:
        cut = rest.rfind(". ", 0, limit)
        cut = cut + 1 if cut > limit // 2 else rest.rfind(" ", 0, limit)
        if cut <= 0:
            cut = limit
        pieces.append(rest[:cut].strip())
        rest = rest[cut:].strip()
    if rest:
        pieces.append(rest)
    return pieces


def paginate(blocks, budget):
    """Rozkłada bloki na strony po ~budget znaków; nagłówek nie zostaje sam na końcu strony."""
    pages, size = [[]], 0
    weights = {"img": IMAGE_WEIGHT, "thumb": THUMB_WEIGHT}
    weight = lambda block: weights.get(block[0], len(block[1]))
    for kind, text, href in blocks:
        is_image = kind in weights
        pieces = [text] if is_image else split_long(text, budget)
        for number, piece in enumerate(pieces):
            block = (kind, piece, href if number == 0 or is_image else None)
            if size and size + weight(block) > budget:
                carry = [pages[-1].pop()] if pages[-1] and pages[-1][-1][0] == "h" else []
                pages.append(carry)
                size = sum(weight(b) for b in carry)
            pages[-1].append(block)
            size += weight(block)
    return [page for page in pages if page]


def get_article(url):
    cached = article_cache.get(url)
    if cached is not None:
        return cached
    final_url, resp = http_request(url)
    if resp.status_code >= 400:
        resp.close()
        log.warning("strona zwróciła %s: %s", resp.status_code, final_url)
        if is_blocked(resp):
            raise FetchError(BLOCKED_MESSAGE, 403, blocked=True)
        raise FetchError(f"Strona zwróciła błąd {resp.status_code}.", 502)
    content_type = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
    if is_video_response(content_type, final_url):
        resp.close()
        raise VideoLink(final_url)  # sam film, nie strona – czytnik przekieruje do /film
    if content_type and not (content_type.startswith("text/") or "html" in content_type or "xml" in content_type):
        resp.close()
        raise FetchError("To nie jest strona z tekstem (np. PDF albo obrazek). Otwórz [Oryginał].", 415)
    text = decode_html(read_body(resp), resp)
    if CHALLENGE_TITLE.search(text[:5000]) and len(text) < 60_000:
        log.warning("strona pokazała sprawdzanie przeglądarki: %s", final_url)
        raise FetchError(BLOCKED_MESSAGE, 403, blocked=True)
    videos, posters = [], {}
    if content_type == "text/plain":
        title = host_of(final_url)
        blocks = [("p", squash(part), None) for part in re.split(r"\n\s*\n", text) if squash(part)]
    else:
        title, blocks = extract_article(text, final_url, videos, posters)
    if not blocks and videos:
        blocks = [("p", "Na tej stronie jest film – wybierz go wyżej.", None)]
    if not blocks:
        raise FetchError("Nie udało się wydobyć tekstu z tej strony. Otwórz [Oryginał].", 422)
    truncated, total, kept = False, 0, []
    for block in blocks:
        total += len(block[1]) if block[0] not in ("img", "thumb") else 0
        if total > ARTICLE_MAX_CHARS:
            truncated = True
            break
        kept.append(block)
    if truncated:
        kept.append(("p", "[Artykuł skrócony – całość w oryginale.]", None))
    article = {"title": title, "url": final_url, "pages": paginate(kept, ARTICLE_PAGE_CHARS), "videos": videos,
               "posters": posters}
    article_cache.set(url, article)
    return article


# ---------- Obrazki dopasowane do telefonu ----------
def shrink_image(raw, max_width=IMAGE_MAX_WIDTH, max_height=IMAGE_MAX_HEIGHT, quality=None):
    """Zmniejsza obrazek do ekranu telefonu i zapisuje jako lekki JPEG (bez przezroczystości i metadanych).
    Zwraca None dla ikonek/pikseli śledzących i plików, których nie da się odczytać."""
    try:
        with Image.open(io.BytesIO(raw)) as source:
            if source.width < IMAGE_MIN_SIZE or source.height < IMAGE_MIN_SIZE:
                return None
            source.draft("RGB", (max_width * 2, max_height * 2))  # JPEG: dekodowanie od razu w mniejszej skali
            image = ImageOps.exif_transpose(source)  # zdjęcia z telefonów bywają obrócone w metadanych
            if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
                rgba = image.convert("RGBA")
                image = Image.new("RGB", rgba.size, (255, 255, 255))
                image.paste(rgba, mask=rgba.getchannel("A"))  # przezroczystość na białym tle
            else:
                image = image.convert("RGB")
            image.thumbnail((max_width, max_height), Image.Resampling.LANCZOS)
            out = io.BytesIO()
            image.save(out, "JPEG", quality=quality or IMAGE_QUALITY, optimize=True, progressive=False)  # zwykły JPEG – najlżejszy do dekodowania
            return out.getvalue()
    except (OSError, ValueError, Image.DecompressionBombError) as err:
        log.info("nie da się przetworzyć obrazka: %s", str(err)[:120])
        return None


def images_enabled():
    return request.cookies.get("obrazki") != "0"


# ---------- Filmy dopasowane do telefonu ----------
# Odtwarzacz Nokii 235 4G / 3210 4G nie udźwignie filmu HD ani strumienia ze strony. Serwer pobiera więc film
# (plik albo strumień HLS .m3u8), przekodowuje go ffmpegiem do małego pliku i podaje do pobrania – telefon otwiera go
# swoim odtwarzaczem. Stan zadań trzymamy w plikach w VIDEO_DIR, więc widzą go wszystkie procesy Gunicorna.
VIDEO_FILE = re.compile(r"\.(mp4|m4v|mov|webm|mkv|3gp|3g2|avi|flv|mpe?g|m3u8)$", re.I)
SCRIPT_VIDEO = re.compile(
    r"""https?:(?:\\?/){2}[^"'\s<>]+?\.(?:mp4|m4v|webm|m3u8|mov|3gp)(?:\?[^"'\s<>]*)?(?=["'\s<>\\]|$)""", re.I
)
SCRIPT_VIDEO_KEY = re.compile(
    r"""["']?(file|src|url|hls|hlsUrl|mp4|source|contentUrl|videoUrl|video_url|stream|manifest)["']?\s*[:=]\s*"""
    r"""["']([^"'\s<>]+\.(?:mp4|m4v|webm|m3u8|mov|3gp)(?:\?[^"'\s<>]*)?)["']""", re.I
)
VIDEO_HINT = re.compile(r"\.(mp4|m4v|webm|m3u8|mov|3gp)(\?|#|$)", re.I)
# Odtwarzacze w ramkach i skryptach: strona odtwarzacza zwykle zawiera adres pliku albo strumienia.
PLAYER_HINT = re.compile(
    r"player|embed|video|wideo|film|vod|stream|/media/|jwplayer|jwplatform|vimeo|wistia|"
    r"brightcove|kaltura|streamable|rumble|vidyard|cda\.pl|tvp\.pl|mux\.com", re.I
)
PLAYER_SKIP = re.compile(  # to nie filmy albo serwisy, których nie obsługujemy (YouTube, sieci społecznościowe, reklamy)
    r"youtube\.com|youtube-nocookie\.com|youtu\.be|dailymotion\.com|dai\.ly|facebook\.com|fbcdn|instagram\.com|tiktok\.com|twitter\.com|//x\.com|"
    r"google\.com/maps|maps\.google|googlesyndication|doubleclick|googletagmanager|disqus|recaptcha|spotify\.com|"
    r"soundcloud\.com|addthis|sharethis|/ads?/|adserver", re.I
)
SCRIPT_PLAYER = re.compile(
    r"https?://(?:cdn\.jwplayer\.com|content\.jwplatform\.com)/(?:v2/media|players|previews)/[a-zA-Z0-9]{8}[^\s\"'<>\\]*|"
    r"https?://fast\.wistia\.(?:net|com)/embed/(?:iframe|medias)/[a-z0-9]{10}|https?://player\.vimeo\.com/video/\d+[^\s\"'<>\\]*",
    re.I,
)
VIMEO_PLAYER = re.compile(r"^https://player\.vimeo\.com/video/\d+", re.I)
KNOWN_PLAYER_PAGE = re.compile(  # strony, z których film bierzemy przez publiczne API odtwarzacza
    r"^https?://(?:www\.)?(?:player\.vimeo\.com/video/|"
    r"(?:cdn\.jwplayer\.com|content\.jwplatform\.com)/(?:players|previews)/|fast\.wistia\.(?:net|com)/embed/)", re.I
)
KALTURA_PARTNER = re.compile(r"""(?:partner_?id["']?\s*[:=]\s*["']?|/p/)(\d{3,9})""", re.I)
KALTURA_ENTRY = re.compile(r"""(?:entry_?id["']?\s*[:=/]\s*["']?)([01]_[a-z0-9]{8})""", re.I)
# ffmpeg czyta tylko lokalne pliki i tylko zwykłe formaty filmów – nigdy list (HLS, concat), które mogłyby wskazać
# pliki serwera albo adresy w sieci wewnętrznej. Listy HLS rozkładamy sami i pobieramy przez http_request.
VIDEO_INPUT_FORMATS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,flv,mpegts,mpeg,ogg,asf,aac,mp3,wav"
VIDEO_FORMATS = {
    "mp4": {"name": "MP4", "mime": "video/mp4", "about": "H.264, do 320×240, ok. 2 MB na minutę"},
    "3gp": {"name": "3GP", "mime": "video/3gpp", "about": "H.263, 176×144, ok. 1,2 MB na minutę – dla starszych odtwarzaczy"},
}
VIDEO_ACTIVE = ("download", "convert")
_ffmpeg = {}
_video_start_lock = threading.Lock()


class VideoLink(Exception):
    """Pod adresem otwieranym w czytniku jest film, a nie strona."""

    def __init__(self, url):
        super().__init__(url)
        self.url = url


def is_video_url(url):
    return bool(VIDEO_FILE.search(urlparse(url).path))


def is_video_response(content_type, url):
    if content_type.startswith("video/") or "mpegurl" in content_type:
        return True
    return is_video_url(url) and ("html" not in content_type)


def player_key(url):
    """Ten sam odtwarzacz pod różnymi adresami (parametry, wistia.net/.com) liczymy raz."""
    return re.sub(r"[?#].*$", "", url.lower()).replace("wistia.net", "wistia.com").replace("/medias/", "/iframe/").rstrip("/")


def first_image_url(value):
    """thumbnailUrl / image z JSON-LD bywa napisem, listą albo obiektem ImageObject."""
    if isinstance(value, list):
        value = value[0] if value else None
    if isinstance(value, dict):
        value = value.get("url") or value.get("contentUrl")
    return value if isinstance(value, str) else None


def find_videos(soup, base_url, deep=False, posters=None):
    """Filmy na stronie, w kolejności: pliki i strumienie podane wprost (<video>, og:video, JSON-LD, atrybuty data-…,
    linki), adresy z konfiguracji odtwarzaczy w skryptach, a na końcu strony odtwarzaczy (iframe, og:video,
    twitter:player) – te otwieramy dopiero przy przygotowaniu filmu i szukamy w nich dalej.
    deep=True (przygotowanie filmu): bierze też ramki bez typowych słów w adresie i zawsze przegląda skrypty.
    Gdy podano słownik `posters`, trafiają do niego miniatury filmów podane przez stronę (adres filmu -> obrazek)."""
    found_posters = {}
    meta_image = None
    for attrs in ({"property": "og:image"}, {"name": "og:image"}, {"name": "twitter:image"}, {"property": "twitter:image"}):
        tag = soup.find("meta", attrs=attrs)
        if tag is not None and (tag.get("content") or "").strip():
            meta_image = tag["content"].strip()
            break
    if KNOWN_PLAYER_PAGE.match(base_url) and not deep:
        if posters is not None and meta_image:
            posters[base_url] = urljoin(base_url, meta_image)
        return [base_url]  # sama strona to odtwarzacz: film weźmiemy z jego API w najlepszej dla telefonu jakości
    direct, players = [], []

    def add(value, target=None, need_ext=False, poster=None):
        value = (value or "").strip()
        for escaped, plain in (("\\/", "/"), ("\\u002F", "/"), ("\\u002f", "/"), ("\\u0026", "&"), ("&amp;", "&")):
            value = value.replace(escaped, plain)
        if not value or value.startswith(("blob:", "data:", "javascript:", "about:")):
            return
        src = urljoin(base_url, value)
        if urlparse(src).scheme not in ("http", "https") or len(src) > MAX_URL_LENGTH or PLAYER_SKIP.search(src):
            return
        if src.split("#")[0] == base_url.split("#")[0] and not KNOWN_PLAYER_PAGE.match(src):
            return
        if target is None:
            target = direct if is_video_url(src) else players
        if need_ext and target is direct and not is_video_url(src):
            return
        key = src if target is direct else player_key(src)
        if src not in direct and key not in (player_key(p) for p in players):
            target.append(src)
        poster = (poster or "").strip()
        if poster and src not in found_posters and not poster.startswith(("data:", "blob:")):
            found_posters[src] = urljoin(base_url, poster)

    for video in soup.find_all("video"):
        candidates = [video.get("src"), video.get("data-src")]
        candidates += [s.get("src") or s.get("data-src") for s in video.find_all("source")]
        for value in candidates:
            if value and not value.strip().startswith(("blob:", "data:")):
                add(value, direct, poster=video.get("poster") or video.get("data-poster"))
                break
    og_type = soup.find("meta", attrs={"property": "og:video:type"})
    og_type = (og_type.get("content") or "").lower() if og_type is not None else ""
    og_direct = og_type.startswith("video/") or "mpegurl" in og_type
    before = len(direct)
    for name in ("og:video:secure_url", "og:video:url", "og:video", "twitter:player:stream", "twitter:player"):
        for meta in soup.find_all("meta", attrs={"property": name}) + soup.find_all("meta", attrs={"name": name}):
            value = meta.get("content")
            if og_direct and name.startswith("og:"):
                add(value, direct, poster=meta_image)
            else:
                add(value, poster=meta_image)  # zwykle strona odtwarzacza (text/html), czasem sam plik
    del direct[before + 1:]  # znaczniki og:/twitter: opisują jeden film (czasem w kilku jakościach)
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            stack = [json.loads(script.string or "")]
        except ValueError:
            continue
        while stack:
            item = stack.pop()
            if isinstance(item, list):
                stack.extend(item)
            elif isinstance(item, dict):
                if "Video" in str(item.get("@type", "")):
                    thumb = first_image_url(item.get("thumbnailUrl") or item.get("image"))
                    if isinstance(item.get("contentUrl"), str):
                        add(item["contentUrl"], direct, poster=thumb)
                    if isinstance(item.get("embedUrl"), str):
                        add(item["embedUrl"], poster=thumb)
                stack.extend(v for v in item.values() if isinstance(v, (list, dict)))
    for tag in soup.find_all(True):  # atrybuty typu data-video-src="…mp4", data-hls="…m3u8", <param value="…">
        for name, value in tag.attrs.items():
            if isinstance(value, str) and (name.startswith("data-") or name in ("value", "content")) and VIDEO_HINT.search(value):
                thumb = next((tag.get(a) for a in ("data-poster", "poster", "data-thumbnail", "data-thumb", "data-image")
                              if isinstance(tag.get(a), str)), None)
                add(value, direct, need_ext=True, poster=thumb)
        classes = " ".join(tag.get("class") or [])
        wistia = re.search(r"wistia_async_([a-z0-9]{10})", classes)
        if wistia:
            add(f"https://fast.wistia.net/embed/iframe/{wistia.group(1)}", players)
    for link in soup.find_all("a", href=True):
        add(link["href"], direct, need_ext=True)
    frames = [f.get("src") or f.get("data-src") or f.get("data-lazy-src") for f in soup.find_all("iframe")]
    for value in filter(None, frames):
        if deep or PLAYER_HINT.search(value):
            add(value, players)
    if deep or not direct:
        scripts = "\n".join(s.string or "" for s in soup.find_all("script"))
        for escaped, plain in (("\\/", "/"), ("\\u002F", "/"), ("\\u002f", "/")):
            scripts = scripts.replace(escaped, plain)
        before = len(direct)
        for match in SCRIPT_VIDEO.finditer(scripts):
            add(match.group(), direct, need_ext=True)
        for match in SCRIPT_VIDEO_KEY.finditer(scripts):  # względne adresy w konfiguracji: "file": "/filmy/a.mp4"
            add(match.group(2), direct, need_ext=True)
        if not deep:
            del direct[before + 1:]  # w skryptach to zwykle ten sam film w kilku jakościach – w czytniku wystarczy jeden
        for match in SCRIPT_PLAYER.finditer(scripts):  # JW Player, Wistia, Vimeo wstawiane skryptem
            add(match.group(), players)
        page = str(soup)
        partner, entry = KALTURA_PARTNER.search(page), KALTURA_ENTRY.search(page)
        if partner and entry and "kaltura" in page.lower():  # Kaltura (m.in. uczelniane serwisy wideo)
            pid, eid = partner.group(1), entry.group(1)
            add(f"https://cdnapisec.kaltura.com/p/{pid}/sp/{pid}00/playManifest/entryId/{eid}"
                f"/format/applehttp/protocol/https/a.m3u8", direct)
    result = (direct + players)[:VIDEOS_PER_ARTICLE * (2 if deep else 1)]
    if posters is not None:
        posters.update({url: found_posters[url] for url in result if url in found_posters})
    return result


def ffmpeg_info():
    """(ścieżka do ffmpeg, lista koderów). ffmpeg pochodzi z pakietu imageio-ffmpeg (instaluje go pip na Render),
    a gdy go brak – z systemu. Bez ffmpeg zwraca (None, "")."""
    if "exe" not in _ffmpeg:
        exe = os.environ.get("FFMPEG_BINARY")
        if not exe:
            try:
                import imageio_ffmpeg

                exe = imageio_ffmpeg.get_ffmpeg_exe()
            except Exception:
                exe = shutil.which("ffmpeg")
        encoders = ""
        if exe:
            try:
                encoders = subprocess.run([exe, "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=30).stdout
            except (OSError, subprocess.SubprocessError):
                exe = None
        _ffmpeg.update(exe=exe, encoders=encoders)
    return _ffmpeg["exe"], _ffmpeg["encoders"]


def encode_args(fmt):
    """Ustawienia ffmpeg dla telefonu. MP4: H.264 Baseline (poziom 1.3) do 320×240, 15 kl./s, AAC mono.
    3GP: H.263 176×144 z dźwiękiem AMR – format, który odtwarza praktycznie każdy telefon z klawiaturą."""
    _, encoders = ffmpeg_info()
    if fmt == "3gp":
        audio = (["-c:a", "libopencore_amrnb", "-ar", "8000", "-b:a", "12.2k"] if "libopencore_amrnb" in encoders
                 else ["-c:a", "aac", "-ar", "16000", "-b:a", "24k"])
        return ["-vf", "scale=176:144:force_original_aspect_ratio=decrease,pad=176:144:(ow-iw)/2:(oh-ih)/2,setsar=1",
                "-r", "15", "-c:v", "h263", "-b:v", "110k", "-maxrate", "160k", "-bufsize", "320k",
                *audio, "-ac", "1", "-movflags", "+faststart", "-f", "3gp"]
    video = (["-c:v", "libx264", "-preset", "veryfast", "-profile:v", "baseline", "-level", "1.3", "-crf", "28",
              "-maxrate", "240k", "-bufsize", "480k", "-g", "30"] if "libx264" in encoders
             else ["-c:v", "mpeg4", "-q:v", "7", "-g", "30"])
    return ["-vf", "scale='if(gt(iw,ih),320,240)':'if(gt(iw,ih),240,320)':force_original_aspect_ratio=decrease"
                   ":force_divisible_by=2,setsar=1",
            "-fpsmax", "15", *video, "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "32k", "-ac", "1", "-ar", "22050",
            "-movflags", "+faststart", "-f", "mp4"]


def video_path(name):
    return os.path.join(VIDEO_DIR, name)


def video_key(src, fmt, part):
    return hashlib.sha1(f"{src}\n{fmt}\n{part}".encode("utf-8")).hexdigest()[:32]


def read_status(key):
    try:
        with open(video_path(key + ".json"), encoding="utf-8") as handle:
            status = json.load(handle)
    except (OSError, ValueError):
        return None
    if status.get("state") in VIDEO_ACTIVE and time.time() - status.get("updated", 0) > VIDEO_STALE:
        status.update(state="error", message="Przygotowanie filmu zostało przerwane (np. restart serwera). Spróbuj ponownie.")
    if status.get("state") == "done" and not os.path.isfile(video_path(f"{key}.{status.get('fmt')}")):
        return None  # plik już usunięty – trzeba przygotować od nowa
    return status


def write_status(key, status):
    status["updated"] = time.time()
    tmp = video_path(f"{key}.{uuid.uuid4().hex}.tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(status, handle)
    os.replace(tmp, video_path(key + ".json"))


def active_video_jobs():
    count = 0
    for name in os.listdir(VIDEO_DIR):
        if name.endswith(".json"):
            status = read_status(name[:-5])
            count += bool(status and status.get("state") in VIDEO_ACTIVE)
    return count


def cleanup_videos():
    """Usuwa pliki starsze niż VIDEO_KEEP_SECONDS, a gdy zajmują za dużo miejsca – najstarsze gotowe filmy i źródła."""
    now, files = time.time(), []
    for name in os.listdir(VIDEO_DIR):
        path = video_path(name)
        try:
            info = os.stat(path)
        except OSError:
            continue
        if now - info.st_mtime > VIDEO_KEEP_SECONDS:
            try:
                os.remove(path)
            except OSError:
                pass
        elif not name.endswith((".json", ".claim", ".tmp")):
            files.append((info.st_mtime, info.st_size, path))
    total = sum(size for _, size, _ in files)
    for mtime, size, path in sorted(files):
        if total <= VIDEO_DISK_LIMIT:
            break
        if now - mtime < 3600 or ".work." in path or path.endswith(".dl"):
            continue  # pliki zadań, które jeszcze trwają
        try:
            os.remove(path)
            total -= size
        except OSError:
            pass


class Download:
    """Pobieranie filmu na dysk (w kawałkach – nie w pamięci) z limitem rozmiaru i czasu oraz raportem postępu."""

    def __init__(self, report, segments=0):
        self.report, self.segments = report, segments
        self.got, self.done_segments, self.last = 0, 0, 0.0
        self.started = time.monotonic()

    def copy(self, resp, handle, expected=0):
        try:
            for chunk in resp.iter_content(65536):
                handle.write(chunk)
                self.got += len(chunk)
                if self.got > VIDEO_SOURCE_MAX_BYTES:
                    raise FetchError(f"Film jest za duży (limit {VIDEO_SOURCE_MAX_BYTES // 1_000_000} MB).", 413)
                if time.monotonic() - self.started > VIDEO_DOWNLOAD_DEADLINE:
                    raise FetchError("Pobieranie filmu trwało za długo. Spróbuj ponownie później.", 504)
                if time.monotonic() - self.last > 2:
                    self.tick(expected)
        except requests.exceptions.RequestException:
            raise FetchError("Połączenie z serwerem filmu zostało przerwane. Spróbuj ponownie.", 502)
        finally:
            resp.close()

    def tick(self, expected=0):
        self.last = time.monotonic()
        if self.segments:
            progress = self.done_segments * 100 // self.segments
        else:
            progress = self.got * 100 // expected if expected else 0
        self.report(got=self.got, progress=min(progress, 99))


def open_media(url, headers):
    _, resp = http_request(url, extra_headers=headers)
    if resp.status_code >= 400:
        resp.close()
        log.warning("serwer filmu zwrócił %s: %s", resp.status_code, url)
        if is_blocked(resp):
            raise FetchError("Serwer filmu blokuje Szukajkę. Otwórz stronę z filmem bezpośrednio w Operze.", 403, blocked=True)
        raise FetchError(f"Serwer filmu zwrócił błąd {resp.status_code}.", 502)
    return resp


HLS_ATTR = re.compile(r'([A-Z0-9-]+)=("[^"]*"|[^,]*)')


def hls_attrs(line):
    return {name: value.strip('"') for name, value in HLS_ATTR.findall(line.split(":", 1)[1])}


def parse_m3u8(text, base_url):
    """Lista HLS: warianty jakości (lista główna) albo odcinki filmu z czasem trwania."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines or not lines[0].startswith("#EXTM3U"):
        raise FetchError("Nieprawidłowa lista odtwarzania (HLS).", 415)
    playlist = {"variants": [], "media": [], "segments": [], "init": None, "key": None, "byterange": False}
    pending, duration = None, None
    for line in lines:
        if line.startswith("#EXT-X-STREAM-INF:"):
            pending = hls_attrs(line)
        elif line.startswith("#EXT-X-MEDIA:"):
            playlist["media"].append(hls_attrs(line))
        elif line.startswith("#EXTINF:"):
            try:
                duration = float(line[8:].split(",")[0])
            except ValueError:
                duration = 0.0
        elif line.startswith("#EXT-X-KEY:"):
            method = hls_attrs(line).get("METHOD", "NONE")
            if method != "NONE":
                playlist["key"] = method
        elif line.startswith("#EXT-X-MAP:"):
            playlist["init"] = urljoin(base_url, hls_attrs(line).get("URI", ""))
        elif line.startswith("#EXT-X-BYTERANGE"):
            playlist["byterange"] = True
        elif not line.startswith("#"):
            uri = urljoin(base_url, line)
            if pending is not None:
                playlist["variants"].append(dict(pending, uri=uri))
                pending = None
            elif duration is not None:
                playlist["segments"].append((duration, uri))
                duration = None
    return playlist


def choose_variant(variants):
    """Najniższa jakość, która nadal wypełni ekran 240×320 – najmniej danych do pobrania i dekodowania."""
    def height(variant):
        match = re.match(r"\d+x(\d+)", variant.get("RESOLUTION", ""))
        return int(match.group(1)) if match else 0

    def bandwidth(variant):
        try:
            return int(variant.get("BANDWIDTH") or 0)
        except ValueError:
            return 0

    with_video = [v for v in variants if height(v) or not re.fullmatch(r"\s*mp4a[^,]*", v.get("CODECS", ""))]
    with_video = with_video or variants
    enough = [v for v in with_video if height(v) >= 216]
    if enough:
        return min(enough, key=lambda v: (height(v), bandwidth(v)))
    if any(height(v) for v in with_video):
        return max(with_video, key=lambda v: (height(v), -bandwidth(v)))
    return min(with_video, key=bandwidth)


def fetch_playlist(url, headers):
    resp = open_media(url, headers)
    return parse_m3u8(read_body(resp, limit=2_000_000).decode("utf-8", "replace"), url)


def pick_segments(playlist, start, end):
    """Odcinki HLS pokrywające czas [start, end) i przesunięcie początku części względem pierwszego z nich."""
    chosen, moment, offset = [], 0.0, None
    for duration, uri in playlist["segments"]:
        if moment + duration > start and moment < end:
            if offset is None:
                offset = start - moment
            chosen.append(uri)
        moment += duration
        if moment >= end:
            break
    return chosen, max(0.0, offset or 0.0)


def prepare_hls(url, text, headers, part, report):
    """Pobiera odcinki strumienia HLS dla danej części filmu i skleja je w jeden plik (osobno obraz i dźwięk)."""
    playlist, audio = parse_m3u8(text, url), None
    if playlist["variants"]:
        variant = choose_variant(playlist["variants"])
        group = variant.get("AUDIO")
        options = [m for m in playlist["media"] if m.get("TYPE") == "AUDIO" and m.get("GROUP-ID") == group and m.get("URI")]
        if group and options:
            chosen = next((m for m in options if m.get("DEFAULT") == "YES"), options[0])
            audio = fetch_playlist(urljoin(url, chosen["URI"]), headers)
        playlist = fetch_playlist(variant["uri"], headers)
    lists = [("v", playlist)] + ([("a", audio)] if audio else [])
    for _, item in lists:
        if item["variants"] or not item["segments"]:
            raise FetchError("Nie udało się odczytać strumienia (HLS).", 415)
        if item["key"]:
            raise FetchError("Ten film jest zaszyfrowany (DRM) – nie da się go przekodować. Otwórz [Oryginał].", 415)
        if item["byterange"]:
            raise FetchError("Ten rodzaj strumienia HLS nie jest obsługiwany.", 415)
    total = sum(duration for duration, _ in playlist["segments"])
    start = part * VIDEO_PART_SECONDS
    if start >= total:
        raise FetchError("Ten film nie ma takiej części.", 404)
    base = "hls-" + hashlib.sha1(f"{url}\n{part}".encode("utf-8")).hexdigest()[:32]
    picked = [(suffix, item) + pick_segments(item, start, start + VIDEO_PART_SECONDS) for suffix, item in lists]
    download = Download(report, segments=sum(len(uris) + bool(item["init"]) for _, item, uris, _ in picked))
    inputs = []
    for suffix, item, uris, offset in picked:
        path = video_path(f"{base}.{suffix}")
        if not os.path.isfile(path):
            tmp = f"{path}.{uuid.uuid4().hex}.dl"
            try:
                with open(tmp, "wb") as handle:
                    for uri in ([item["init"]] if item["init"] else []) + uris:
                        download.copy(open_media(uri, headers), handle)
                        download.done_segments += 1
                        download.tick()
                os.replace(tmp, path)
            finally:
                if os.path.exists(tmp):
                    os.remove(tmp)
        else:
            os.utime(path)
        inputs.append((path, offset))
    return inputs, total


def vimeo_stream(url, referer):
    """Vimeo: strona odtwarzacza (player.vimeo.com) zawiera konfigurację z adresem strumienia HLS (ważnym kilka godzin)."""
    headers = {"Accept": "text/html,*/*;q=0.5"}
    if referer:
        headers["Referer"] = referer  # filmy dozwolone tylko na wybranych stronach wymagają adresu tej strony
    resp = open_media(url, headers)
    html = decode_html(read_body(resp), resp)
    start = html.find("window.playerConfig")
    try:
        config, _ = json.JSONDecoder().raw_decode(html, html.index("{", start))
        files = config["request"]["files"]
    except (ValueError, KeyError, TypeError):
        raise FetchError("Vimeo nie udostępnia tego filmu (prywatny, płatny albo tylko do osadzenia na innej stronie).", 415)
    hls = files.get("hls") or {}
    cdns = hls.get("cdns") or {}
    for name in [hls.get("default_cdn")] + list(cdns):
        stream = (cdns.get(name) or {}).get("url")
        if stream:
            return stream
    progressive = [p for p in files.get("progressive") or [] if p.get("url")]
    if progressive:  # starsze filmy: zwykłe pliki MP4 – najmniejszy, który wypełni ekran
        enough = [p for p in progressive if (p.get("height") or 0) >= 216]
        return min(enough or progressive, key=lambda p: p.get("height") or 0)["url"]
    raise FetchError("Vimeo nie podało adresu tego filmu.", 415)


def read_json(url, headers=None):
    resp = open_media(url, dict({"Accept": "application/json"}, **(headers or {})))
    try:
        return json.loads(read_body(resp, limit=3_000_000).decode("utf-8", "replace"))
    except ValueError:
        raise FetchError("Odtwarzacz zwrócił nieczytelne dane.", 502)


def smallest_enough(items, height_key="height"):
    """Najmniejszy wariant, który nadal wypełni ekran (wysokość ≥ 216 px), a gdy takiego nie ma – największy."""
    sized = [i for i in items if isinstance(i.get(height_key), (int, float))]
    enough = [i for i in sized if i[height_key] >= 216]
    if enough:
        return min(enough, key=lambda i: i[height_key])
    return max(sized, key=lambda i: i[height_key]) if sized else items[0]


def player_stream(url, referer):
    """Znane odtwarzacze, które podają film przez publiczne API (bez klucza): adres pliku/strumienia albo None."""
    host = (urlparse(url).hostname or "").lower()
    if VIMEO_PLAYER.match(url):
        return vimeo_stream(url, referer)
    if host.endswith(("jwplayer.com", "jwplatform.com")) and not is_video_url(url):
        match = re.search(r"/(?:v2/media|players|previews|manifests)/([a-zA-Z0-9]{8})", url)
        if match:
            data = read_json(f"https://cdn.jwplayer.com/v2/media/{match.group(1)}")
            sources = [s for item in data.get("playlist") or [] for s in item.get("sources") or [] if s.get("file")]
            hls = [s for s in sources if "mpegurl" in (s.get("type") or "").lower() or ".m3u8" in s["file"]]
            files = [s for s in sources if (s.get("type") or "").startswith("video/") and s.get("height")]
            if files:
                return smallest_enough(files)["file"]
            if hls:
                return hls[0]["file"]
            raise FetchError("JW Player nie udostępnia tego filmu.", 415)
    if "wistia" in host:
        match = re.search(r"/(?:iframe|medias)/([a-z0-9]{10})", url)
        if match:
            media = read_json(f"https://fast.wistia.com/embed/medias/{match.group(1)}.json").get("media") or {}
            assets = [a for a in media.get("assets") or [] if a.get("url") and a.get("container") == "mp4"]
            if assets:
                return smallest_enough(assets)["url"]
            raise FetchError("Wistia nie udostępnia tego filmu.", 415)
    return None


def prepare_source(src, referer, part, report, depth=0, seen=None):
    """Pobiera źródło filmu na dysk. Zwraca ([(plik, przesunięcie_początku_s)], długość_całości_s albo None).
    Gdy pod adresem jest strona (np. odtwarzacz osadzony w ramce), szuka w niej filmu – najwyżej 2 poziomy w głąb."""
    seen = seen if seen is not None else set()
    seen.add(src)
    if PLAYER_SKIP.search(src):
        raise FetchError("Filmów z tego serwisu (np. YouTube, Dailymotion, Facebook) nie da się tu obejrzeć. Otwórz [Oryginał].", 415)
    if not is_video_url(src) and depth < 4:
        stream = player_stream(src, referer)
        if stream:
            return prepare_source(stream, src, part, report, depth + 1, seen)
    headers = {"Accept": "*/*"}
    if referer:
        headers["Referer"] = referer
    cached = video_path("src-" + hashlib.sha1(src.encode("utf-8")).hexdigest()[:32] + ".bin")
    if os.path.isfile(cached):
        os.utime(cached)
        return [(cached, part * VIDEO_PART_SECONDS)], None
    resp = open_media(src, headers)
    final_url = resp.url or src
    content_type = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
    if "mpegurl" in content_type or urlparse(final_url).path.lower().endswith(".m3u8"):
        return prepare_hls(final_url, read_body(resp, limit=2_000_000).decode("utf-8", "replace"), headers, part, report)
    if "html" in content_type:  # strona z filmem albo strona odtwarzacza – szukamy w niej dalej
        html = decode_html(read_body(resp), resp)
        report(got=0)  # znak życia – szukanie po odtwarzaczach może chwilę potrwać
        error = FetchError("Nie znalazłem filmu na tej stronie (odtwarzacz może go chronić albo to YouTube). "
                           "Otwórz [Oryginał].", 415)
        if depth >= 3:
            raise error
        found = find_videos(BeautifulSoup(CONTROL_CHARS.sub("", html), "lxml"), final_url, deep=True)
        for candidate in [c for c in found if c not in seen][: 6 if depth == 0 else 3]:
            try:
                return prepare_source(candidate, final_url, part, report, depth + 1, seen)
            except FetchError as err:
                log.info("film: %s nie zadziałał (%s)", candidate, err.message)
                if "Nie znalazłem" in error.message and "Nie znalazłem" not in err.message:
                    error = err  # pierwszy konkretny błąd (np. za duży, zaszyfrowany) mówi więcej niż ogólny
        raise error
    expected = int(resp.headers.get("Content-Length") or 0)
    if expected > VIDEO_SOURCE_MAX_BYTES:
        resp.close()
        raise FetchError(f"Film jest za duży ({expected // 1_000_000} MB, limit {VIDEO_SOURCE_MAX_BYTES // 1_000_000} MB).", 413)
    tmp = f"{cached}.{uuid.uuid4().hex}.dl"
    try:
        with open(tmp, "wb") as handle:
            Download(report).copy(resp, handle, expected)
        os.replace(tmp, cached)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return [(cached, part * VIDEO_PART_SECONDS)], None


def probe_video(exe, path):
    """(długość w s albo None, czy jest obraz) – z opisu pliku, który ffmpeg wypisuje przy otwarciu."""
    try:
        out = subprocess.run(
            [exe, "-hide_banner", "-nostdin", "-protocol_whitelist", "file", "-format_whitelist", VIDEO_INPUT_FORMATS,
             "-i", path], capture_output=True, text=True, errors="replace", timeout=60,
        ).stderr
    except subprocess.TimeoutExpired:
        raise FetchError("Nie udało się odczytać pliku filmu.", 415)
    match = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", out)
    duration = int(match.group(1)) * 3600 + int(match.group(2)) * 60 + float(match.group(3)) if match else None
    return duration, bool(re.search(r"Stream #\S+.*: Video:", out))


def run_ffmpeg(cmd, length, report):
    if shutil.which("nice"):
        cmd = ["nice", "-n", "10"] + cmd  # strony czytnika mają pierwszeństwo przed przekodowaniem
    with tempfile.TemporaryFile() as errors:
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=errors, text=True)
        timed_out = threading.Event()

        def stop():
            timed_out.set()
            proc.kill()

        timer = threading.Timer(VIDEO_CONVERT_DEADLINE, stop)
        timer.start()
        last = 0.0
        try:
            for line in proc.stdout:
                if line.startswith("out_time_us=") and time.monotonic() - last > 2:
                    try:
                        done = int(line.split("=", 1)[1]) / 1_000_000
                    except ValueError:
                        continue
                    last = time.monotonic()
                    report(progress=max(0, min(99, int(done * 100 / max(length, 1)))))
            code = proc.wait()
        finally:
            timer.cancel()
        if code != 0:
            errors.seek(0)
            log.warning("ffmpeg zakończył się kodem %s: %s", code, errors.read()[-600:].decode("utf-8", "replace"))
            if timed_out.is_set():
                raise FetchError("Przekodowanie trwało za długo. Spróbuj krótszego filmu.", 504)
            raise FetchError("Nie udało się przekodować filmu (nieobsługiwany format?).", 415)


def video_job(key, src, referer, fmt, part):
    """Zadanie w tle: pobranie źródła, przekodowanie, zapis gotowego pliku. Postęp zapisuje do <key>.json."""
    status = {"state": "download", "fmt": fmt, "part": part, "got": 0, "progress": 0}

    def report(**changes):
        status.update(changes)
        write_status(key, status)

    out_tmp = video_path(f"{key}.work.{fmt}")
    try:
        cleanup_videos()
        exe, _ = ffmpeg_info()
        if not exe:
            raise FetchError("Na serwerze brakuje programu ffmpeg (pakiet imageio-ffmpeg).", 500)
        inputs, total = prepare_source(src, referer, part, report)
        duration, has_video = probe_video(exe, inputs[0][0])
        if not has_video:
            raise FetchError("W tym pliku nie ma obrazu albo jego format nie jest obsługiwany.", 415)
        total = total or duration
        start = part * VIDEO_PART_SECONDS
        if total and start >= total:
            raise FetchError("Ten film nie ma takiej części.", 404)
        length = min(VIDEO_PART_SECONDS, total - start) if total else VIDEO_PART_SECONDS
        report(state="convert", progress=0, total=total, length=length)
        cmd = [exe, "-hide_banner", "-nostdin", "-y", "-loglevel", "error"]
        for path, offset in inputs:
            cmd += ["-protocol_whitelist", "file", "-format_whitelist", VIDEO_INPUT_FORMATS]
            if offset > 0.05:
                cmd += ["-ss", f"{offset:.2f}"]
            cmd += ["-i", path]
        cmd += ["-t", str(VIDEO_PART_SECONDS), "-map", "0:v:0", "-map", "1:a:0?" if len(inputs) > 1 else "0:a:0?",
                "-sn", "-dn", "-map_metadata", "-1", "-threads", "2", *encode_args(fmt),
                "-progress", "pipe:1", "-nostats", out_tmp]
        run_ffmpeg(cmd, length, report)
        out = video_path(f"{key}.{fmt}")
        os.replace(out_tmp, out)
        report(state="done", progress=100, size=os.path.getsize(out))
        log.info("film gotowy: %s część %s (%s, %d B)", src, part + 1, fmt, status["size"])
    except FetchError as err:
        log.warning("film nieudany: %s – %s", src, err.message)
        report(state="error", message=err.message, blocked=err.blocked)
    except Exception:
        log.exception("film nieudany: %s", src)
        report(state="error", message="Nie udało się przygotować filmu. Spróbuj ponownie albo wybierz inny format.")
    finally:
        for path in (out_tmp, video_path(key + ".claim")):
            if os.path.exists(path):
                os.remove(path)


def start_video_job(key, src, referer, fmt, part):
    """Uruchamia przygotowanie filmu w tle. False, gdy serwer zajmuje się już VIDEO_JOBS innymi filmami."""
    os.makedirs(VIDEO_DIR, exist_ok=True)
    with _video_start_lock:
        current = read_status(key)
        if current and current.get("state") in VIDEO_ACTIVE + ("done",):
            return True
        if active_video_jobs() >= VIDEO_JOBS:
            return False
        claim = video_path(key + ".claim")  # chroni przed startem tego samego zadania w drugim procesie Gunicorna
        try:
            os.close(os.open(claim, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
        except FileExistsError:
            if time.time() - os.path.getmtime(claim) < 30:
                return True
            os.utime(claim)
        write_status(key, {"state": "download", "fmt": fmt, "part": part, "got": 0, "progress": 0})
    threading.Thread(target=video_job, args=(key, src, referer, fmt, part), daemon=True).start()
    return True


POSTER_IN_SCRIPT = re.compile(
    r"""["']?(?:poster|image|thumbnail|thumbnailUrl|thumb|preview)["']?\s*[:=]\s*"""
    r"""["'](https?:[^"'\s<>]+?\.(?:jpe?g|png|webp)(?:\?[^"'\s<>]*)?)["']""", re.I
)


def fetch_image(url, site, size):
    """Pobiera obrazek i zmniejsza go dla telefonu (JPEG) albo zwraca None."""
    headers = {"Accept": "image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8"}
    if site:
        headers["Referer"] = site + "/"
    try:
        _, resp = http_request(url, extra_headers=headers)
    except FetchError:
        return None
    if resp.status_code >= 400 or not resp.headers.get("Content-Type", "").lower().startswith("image/"):
        resp.close()
        return None
    try:
        return shrink_image(read_body(resp, limit=IMAGE_MAX_BYTES), *size)
    except FetchError:
        return None


def add_play_icon(jpeg):
    """Nakłada na miniaturę okrągły znak „odtwórz”, żeby od razu było widać, że to film."""
    with Image.open(io.BytesIO(jpeg)) as source:
        image = source.convert("RGBA")
    width, height = image.size
    radius = max(10, min(width, height) // 6)
    cx, cy = width // 2, height // 2
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=(0, 0, 0, 150),
                 outline=(255, 255, 255, 230), width=max(1, radius // 8))
    side = radius * 0.5
    draw.polygon([(cx - side * 0.6, cy - side), (cx - side * 0.6, cy + side), (cx + side, cy)], fill=(255, 255, 255, 245))
    out = io.BytesIO()
    Image.alpha_composite(image, overlay).convert("RGB").save(out, "JPEG", quality=IMAGE_QUALITY, optimize=True)
    return out.getvalue()


FRAME_CHUNK = 4_000_000  # tyle początku (i ewentualnie końca) pliku pobieramy na miniaturę
FRAME_FULL_LIMIT = 25_000_000  # gdy serwer nie podaje fragmentów, mniejszy plik pobieramy cały


def fetch_range(url, headers, start, end):
    """Fragment pliku (nagłówek Range) albo None, gdy serwer nie obsługuje pobierania fragmentów."""
    try:
        _, resp = http_request(url, extra_headers=dict(headers, Range=f"bytes={start}-{end}"))
    except FetchError:
        return None
    if resp.status_code != 206:
        resp.close()
        return None
    return read_body(resp, limit=end - start + 1)


def video_frame(url, referer):
    """Klatka z początku filmu (ok. 2. sekunda): pobiera tylko początek pliku albo jeden odcinek strumienia HLS."""
    exe, _ = ffmpeg_info()
    if not exe:
        return None
    headers = {"Accept": "*/*"}
    if referer:
        headers["Referer"] = referer
    resp = open_media(url, headers)
    final_url = resp.url or url
    content_type = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
    os.makedirs(VIDEO_DIR, exist_ok=True)
    path = video_path(f"frame-{uuid.uuid4().hex}.tmp")
    try:
        with open(path, "wb") as handle:
            if "mpegurl" in content_type or urlparse(final_url).path.lower().endswith(".m3u8"):
                resp_text = read_body(resp, limit=2_000_000).decode("utf-8", "replace")
                playlist = parse_m3u8(resp_text, final_url)
                if playlist["variants"]:
                    playlist = fetch_playlist(choose_variant(playlist["variants"])["uri"], headers)
                if playlist["key"] or playlist["byterange"] or not playlist["segments"]:
                    return None
                total = sum(duration for duration, _ in playlist["segments"])
                moment = min(max(2.0, total * 0.1), 60.0, max(0.0, total - 1))  # początek filmu bywa czarny lub wyciemniony
                uris, seek = pick_segments(playlist, moment, moment + 1)
                for uri in ([playlist["init"]] if playlist["init"] else []) + uris[:1]:
                    handle.write(read_body(open_media(uri, headers), limit=8_000_000))
            elif "html" in content_type:
                resp.close()
                return None
            else:
                total = int(resp.headers.get("Content-Length") or 0)
                head = read_body(resp, limit=FRAME_CHUNK)
                handle.write(head)
                if len(head) >= FRAME_CHUNK and total > len(head):
                    # Indeks MP4 („moov”) bywa na końcu pliku: dokładamy koniec pliku na właściwym miejscu
                    # (plik rzadki – środek nie zajmuje miejsca na dysku i nie jest pobierany).
                    tail = fetch_range(final_url, headers, max(len(head), total - FRAME_CHUNK), total - 1)
                    if tail:
                        handle.seek(total - len(tail))
                        handle.write(tail)
                    elif total <= FRAME_FULL_LIMIT:  # serwer bez Range: mały plik pobieramy w całości
                        handle.seek(0)
                        handle.write(read_body(open_media(final_url, headers), limit=FRAME_FULL_LIMIT))
                seek = 2
        for start in (seek, 0):
            cmd = [exe, "-hide_banner", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file",
                   "-format_whitelist", VIDEO_INPUT_FORMATS, "-ss", f"{start:.2f}", "-i", path, "-frames:v", "1",
                   "-vf", "scale=320:-2", "-f", "image2", "-c:v", "mjpeg", "pipe:1"]
            try:
                frame = subprocess.run(cmd, capture_output=True, timeout=15).stdout
            except subprocess.TimeoutExpired:
                return None
            if frame:
                return shrink_image(frame, *VIDEO_POSTER_SIZE)
        return None
    finally:
        if os.path.exists(path):
            os.remove(path)


def poster_sources(url, referer, depth=0):
    """Skąd wziąć miniaturę filmu: adresy obrazków (z API odtwarzacza albo ze strony odtwarzacza),
    a dla samych plików i strumieni ("klatka", adres)."""
    host = (urlparse(url).hostname or "").lower()
    if VIMEO_PLAYER.match(url) or re.match(r"^https://(?:www\.)?vimeo\.com/\d+", url):
        thumb = read_json("https://vimeo.com/api/oembed.json?url=" + quote(url, safe="")).get("thumbnail_url")
        return [thumb] if thumb else []
    if host.endswith(("jwplayer.com", "jwplatform.com")) and not is_video_url(url):
        match = re.search(r"/(?:v2/media|players|previews|manifests)/([a-zA-Z0-9]{8})", url)
        if match:
            return [f"https://cdn.jwplayer.com/v2/media/{match.group(1)}/poster.jpg?width=320"]
    if "wistia" in host:
        thumb = read_json("https://fast.wistia.com/oembed?url=" + quote(url, safe="")).get("thumbnail_url")
        return [thumb] if thumb else []
    kaltura = re.search(r"kaltura\.com/p/(\d+)/sp/\d+/playManifest/entryId/([01]_[a-z0-9]{8})", url)
    if kaltura:
        return [f"https://cdnapisec.kaltura.com/p/{kaltura.group(1)}/thumbnail/entry_id/{kaltura.group(2)}/width/320"]
    if is_video_url(url):
        return [("klatka", url)]
    headers = {"Accept": "text/html,*/*;q=0.5"}
    if referer:
        headers["Referer"] = referer
    resp = open_media(url, headers)
    final_url = resp.url or url
    content_type = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
    if is_video_response(content_type, final_url):
        resp.close()
        return [("klatka", final_url)]
    if "html" not in content_type:
        resp.close()
        return []
    html = CONTROL_CHARS.sub("", decode_html(read_body(resp), resp))
    soup = BeautifulSoup(html, "lxml")
    posters = {}
    found = find_videos(soup, final_url, deep=True, posters=posters)
    # kolejność: miniatura od strony -> klatka z filmu -> zdjęcie strony i obrazki z konfiguracji odtwarzacza
    sources = [posters[f] for f in found if f in posters]
    if found and is_video_url(found[0]):
        sources.append(("klatka", found[0]))
    elif found and not sources and depth < 2:
        sources += poster_sources(found[0], final_url, depth + 1)  # odtwarzacz w ramce (także ramka w ramce)
    lead = lead_image(soup, final_url)
    if lead:
        sources.append(lead[0])
    sources += [m.group(1).replace("\\/", "/") for m in POSTER_IN_SCRIPT.finditer(html)][:2]
    return sources


def video_poster(url, site):
    """Miniatura filmu ze znakiem „odtwórz” (JPEG) albo None. Najpierw obrazek podany przez stronę lub odtwarzacz,
    a gdy go brak – klatka z początku filmu."""
    started = time.monotonic()
    try:
        sources = poster_sources(url, site + "/" if site else None)
    except FetchError:
        return None
    for source in sources[:4]:
        if time.monotonic() - started > 25:
            break
        try:
            data = video_frame(source[1], url) if isinstance(source, tuple) else fetch_image(source, site, VIDEO_POSTER_SIZE)
        except FetchError:
            data = None
        if data:
            return data
    return None


def mmss(seconds):
    seconds = int(seconds or 0)
    hours, rest = divmod(seconds, 3600)
    return f"{hours}:{rest // 60:02d}:{rest % 60:02d}" if hours else f"{rest // 60}:{rest % 60:02d}"


def megabytes(size):
    return f"{(size or 0) / 1_000_000:.1f} MB".replace(".", ",")


# ---------- Szablony ----------
# Prosty HTML z małym, wbudowanym blokiem stylów (ok. 1 KB, bez plików CSS, flexboxa, grida i JavaScriptu): tylko
# kolory, odstępy, ramki i opływanie miniatury tekstem – to Opera Mini na telefonach z klawiaturą obsługuje dobrze.
STYLE = (
    "body{margin:0;font-family:sans-serif;font-size:14px;line-height:1.35;color:#222;background:#fff}"
    "a{color:#0b57d0}"
    ".bar{background:#0b57d0;color:#fff;padding:5px 6px;font-size:12px}.bar a{color:#fff}"
    ".w{padding:4px 6px}"
    "h1{font-size:17px;line-height:1.25;margin:6px 0 2px}"
    "h2{font-size:15px;line-height:1.25;margin:12px 0 4px}"
    "p{margin:0 0 8px}"
    ".m{color:#777;font-size:12px;margin:0 0 8px}"
    ".it{border-bottom:1px solid #e3e3e3;padding:6px 0;overflow:hidden}"
    ".it img{float:left;width:80px;margin:0 6px 0 0}"
    ".it a{font-weight:bold;text-decoration:none}.it a.n{display:block;margin-left:86px}"
    ".ph{margin:4px 0 10px}.ph img{max-width:100%;border:0}"
    ".v{display:block;margin:6px 0 10px;padding:4px;text-align:center;font-weight:bold;text-decoration:none;"
    "background:#eef3fd;border:1px solid #c6d5f5}.v img{max-width:100%;margin:0 0 4px}"
    ".r{border-bottom:1px solid #e3e3e3;padding:6px 0}"
    ".r a.t{font-weight:bold;text-decoration:none}"
    ".h{color:#1e7d32;font-size:12px}.s{color:#444}.o{font-size:12px}"
    ".b{display:block;background:#eef3fd;border:1px solid #c6d5f5;padding:7px;margin:8px 0;"
    "text-align:center;font-weight:bold;text-decoration:none}"
    ".f{border-top:1px solid #e3e3e3;padding:6px;font-size:12px;color:#777}"
    ".q{width:140px}.u{width:200px}.hl{background:#fff3a0}.e{background:#fff4e5;border:1px solid #f0c890;padding:6px;margin:6px 0}"
)

TEMPLATES = {
    "base.html": """<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>{% block title %}Szukaj{% endblock %}</title>
<style>{{ style }}</style>
{% block head %}{% endblock %}</head>
<body>
{% block body %}{% endblock %}
</body>
</html>
""",
    "_form.html": """<form action="{{ url_for('search') }}" method="get">
<input class="q" type="text" name="q" value="{{ q or '' }}" maxlength="200">
<input type="submit" value="Szukaj">
</form>
""",
    "_nav.html": """<div class="bar">{% if q %}<a href="{{ url_for('search', q=q, p=rp, w=1) }}">{% if request.args.get('l') %}Szukaj w sieci{% else %}&laquo; Wróć do wyników{% endif %}</a> | {% endif %}<a href="{{ url_for('home') }}">Nowe szukanie</a></div>
""",
    "_find_form.html": """<form action="{{ url_for('read') }}" method="get">
{% if fixed_url %}<input type="hidden" name="url" value="{{ fixed_url }}">{% else %}Link:<br><input class="u" type="text" name="url" value="" maxlength="2000"><br>
Szukane słowo (można pominąć):<br>{% endif %}<input class="q" type="text" name="s" value="{{ s or '' }}" maxlength="100">{% if q %}
<input type="hidden" name="q" value="{{ q }}"><input type="hidden" name="rp" value="{{ rp }}">{% endif %}
<input type="submit" value="{{ 'Szukaj na stronie' if fixed_url else 'Otwórz' }}">
</form>
""",
    "home.html": """{% extends "base.html" %}
{% block body %}<div class="bar"><b>Szukajka</b></div>
<div class="w">
{% include "_form.html" %}
<p class="m">Szukaj w sieci i czytaj strony w lekkiej wersji, wygodnej na telefonie z klawiaturą.</p>
<h2>Masz dokładny link?</h2>
{% include "_find_form.html" %}<p class="m">Otwiera tę stronę od razu. Gdy podasz słowo, pokaże tylko fragmenty strony z tym słowem (polskie znaki można pominąć). Link wpisany w górne pole też otwiera stronę od razu.</p>
</div>
{% endblock %}
""",
    "find.html": """{% extends "base.html" %}
{% block title %}{{ s }} - {{ host }}{% endblock %}
{% block body %}{% include "_nav.html" %}<div class="w">
<h1>Szukaj na stronie</h1>
<p class="m">{{ title }} &middot; {{ host }}</p>
{% include "_find_form.html" %}<p><b>&bdquo;{{ s }}&rdquo;</b>: {% if total %}{{ total }} {{ "trafienie" if total == 1 else ("trafienia" if total % 10 in (2, 3, 4) and total % 100 not in (12, 13, 14) else "trafień") }}{% if pages > 1 %} &middot; str. {{ sp }} z {{ pages }}{% endif %}{% else %}nie znaleziono{% endif %}</p>
{% for h in hits %}<div class="r">{% if h.heading %}<b>{% endif %}{{ h.before }}<b class="hl">{{ h.match }}</b>{{ h.after }}{% if h.heading %}</b>{% endif %}<br>
{% if h.href %}<a class="t" href="{{ url_for('read', url=h.href, q=q, rp=rp) }}">Otwórz artykuł</a> &middot; {% endif %}<a class="o" href="{{ url_for('read', url=url, q=q, rp=rp, page=h.page) }}">W tekście (str. {{ h.page }})</a></div>
{% endfor %}{% if not total %}<p>Spróbuj innego słowa albo jego początku (np. &bdquo;prezyd&rdquo; zamiast &bdquo;prezydenta&rdquo;).</p>
{% endif %}{% if sp < pages %}<a class="b" href="{{ url_for('read', url=url, s=s, q=q, rp=rp, sp=sp + 1) }}">Dalsze trafienia &raquo;</a>
{% endif %}{% if sp > 1 %}<a class="b" href="{{ url_for('read', url=url, s=s, q=q, rp=rp, sp=sp - 1) }}">&laquo; Poprzednie trafienia</a>
{% endif %}<a class="b" href="{{ url_for('read', url=url, q=q, rp=rp) }}">Cała strona</a>
</div>
{% include "_nav.html" %}<div class="f"><a href="{{ original }}">[Oryginał]</a></div>
{% endblock %}
""",
    "search.html": """{% extends "base.html" %}
{% block title %}{{ q }} - szukaj{% endblock %}
{% block body %}<div class="bar"><b>Szukajka</b> &middot; wyniki{% if page > 1 %}, str. {{ page }}{% endif %}</div>
<div class="w">
<h1>{{ q }}</h1>
{% if error %}<div class="e">{{ error }}</div>
{% endif %}{% for r in results %}<div class="r"><a class="t" href="{{ url_for('read', url=r.url, q=q, rp=page) }}">{{ r.title }}</a><br>
<span class="h">{{ r.host }}</span>{% if r.snippet %}<br><span class="s">{{ r.snippet }}</span>{% endif %} <a class="o" href="{{ r.url }}">[Oryginał]</a></div>
{% endfor %}{% if not results and not error %}<p>Brak wyników.</p>
{% endif %}{% if has_more %}<a class="b" href="{{ url_for('search', q=q, p=page + 1) }}">Następna strona &raquo;</a>
{% endif %}{% if page > 1 %}<a class="b" href="{{ url_for('search', q=q, p=page - 1) }}">&laquo; Poprzednia strona</a>
{% endif %}{% include "_form.html" %}</div>
{% endblock %}
""",
    "read.html": """{% extends "base.html" %}
{% block title %}{{ title }}{% endblock %}
{% block body %}{% include "_nav.html" %}<div class="w">
<h1>{{ title }}</h1>
<p class="m">{{ host }}{% if pages > 1 %} &middot; strona {{ page }} z {{ pages }}{% endif %}</p>
{% if page == 1 %}{% for v in videos %}<a class="v" href="{{ url_for('video', u=v.url, r=original, t=title, q=q, rp=rp, p=v.poster, fb=v.fallback) }}">{% if images %}<img src="{{ url_for('image', u=v.url, v=1, p=v.poster, f=v.fallback, r=site) }}" alt=""><br>{% endif %}Film{% if videos|length > 1 %} {{ loop.index }}{% endif %}: obejrzyj na telefonie</a>
{% endfor %}{% endif %}{% for it in items %}{% if it.kind == "item" %}<div class="it">{% if it.img and images %}<img src="{{ url_for('image', u=it.img, r=site, t=1) }}" alt="">{% endif %}<a{% if it.img and images %} class="n"{% endif %} href="{{ url_for('read', url=it.href, q=q, rp=rp) }}">{{ it.text }}</a></div>
{% elif it.kind == "img" %}{% if images %}<div class="ph"><a href="{{ url_for('image', u=it.href, r=site, hq=1) }}" target="_blank"><img src="{{ url_for('image', u=it.href, r=site) }}" alt="{{ it.text or 'obrazek' }}"></a></div>
{% endif %}{% elif it.kind == "h" %}<h2>{{ it.text }}</h2>
{% else %}<p>{{ it.text }}</p>
{% endif %}{% endfor %}{% if page < pages %}<a class="b" href="{{ url_for('read', url=url, q=q, rp=rp, page=page + 1) }}">Dalej &raquo; ({{ page }}/{{ pages }})</a>
{% endif %}{% if page > 1 %}<a class="b" href="{{ url_for('read', url=url, q=q, rp=rp, page=page - 1) }}">&laquo; Wstecz</a>
{% endif %}{% set fixed_url = url %}{% include "_find_form.html" %}</div>
{% include "_nav.html" %}<div class="f"><a href="{{ original }}">[Oryginał]</a>{% if has_images %} &middot; <a href="{{ url_for('toggle_images', wl=0 if images else 1, next=request.full_path) }}">Obrazki: {{ "wyłącz" if images else "włącz" }}</a>{% endif %}</div>
{% endblock %}
""",
    "film.html": """{% extends "base.html" %}
{% block title %}{{ title }}{% endblock %}
{% block head %}{% if refresh %}<meta http-equiv="refresh" content="{{ refresh }};url={{ here }}">{% endif %}{% endblock %}
{% block body %}<div class="bar">{% if referer %}<a href="{{ url_for('read', url=referer, q=q, rp=rp) }}">&laquo; Wróć do strony</a> | {% elif q %}<a href="{{ url_for('search', q=q, p=rp) }}">&laquo; Wróć do wyników</a> | {% endif %}<a href="{{ url_for('home') }}">Nowe szukanie</a></div>
<div class="w">
<h1>{{ title }}</h1>
<p class="m">{{ host }}{% if status and status.total %} &middot; {{ status.total|mmss }}{% endif %}{% if part > 1 or (status and status.total and status.total > part_seconds) %} &middot; część {{ part }}{% if status and status.total %} z {{ (status.total / part_seconds)|round(0, 'ceil')|int }}{% endif %}{% endif %}</p>
{% if poster_img and mode in ("choose", "done") %}<div class="ph"><img src="{{ poster_img }}" alt=""></div>
{% endif %}{% if mode == "choose" %}{% for f, info in formats.items() %}<a class="b" href="{{ link(f=f) }}">{{ info.name }}{% if ready[f] %} &ndash; gotowy{% endif %}</a>
<p class="m">{{ info.about }}</p>
{% endfor %}<p>Serwer pobiera film i zmniejsza go dla telefonu. Krótki film jest gotowy po chwili, długi po kilku minutach. Gotowy plik otworzy odtwarzacz telefonu. Długie filmy są dzielone na części po {{ part_minutes }} min.</p>
<p class="m">Zacznij od MP4. Gdy telefon go nie odtworzy, wybierz 3GP.</p>
{% elif mode == "busy" %}<p>Serwer przygotowuje teraz inny film. Ten zacznie się zaraz po nim &ndash; strona odświeża się sama.</p>
<a class="b" href="{{ here }}">Odśwież</a>
{% elif mode == "work" %}<p><b>Przygotowuję film {{ fmt_name }}&hellip;</b></p>
<p>{% if status.state == "download" %}Pobieranie: {{ status.got|mb }}{% if status.progress %} ({{ status.progress }}%){% endif %}{% else %}Zmniejszanie dla telefonu: {{ status.progress }}%{% endif %}</p>
<a class="b" href="{{ here }}">Odśwież</a>
<p class="m">Strona odświeża się sama co {{ refresh }} s. Możesz też wyjść i wrócić tu później.</p>
{% elif mode == "done" %}<a class="b" href="{{ url_for('video_file', key=key, ext=fmt) }}">Odtwórz film ({{ fmt_name }}, {{ status.size|mb }})</a>
<p class="m">{% if status.length %}Czas: {{ status.length|mmss }}. {% endif %}Plik otworzy odtwarzacz telefonu.</p>
<p><a href="{{ url_for('video_file', key=key, ext=fmt, d=1) }}">Zapisz w pamięci telefonu</a></p>
{% if status.total and status.total > part * part_seconds %}<a class="b" href="{{ link(f=fmt, c=part + 1) }}">Następna część ({{ part + 1 }}) &raquo;</a>
{% endif %}{% if part > 1 %}<a class="b" href="{{ link(f=fmt, c=part - 1) }}">&laquo; Poprzednia część</a>
{% endif %}<p><a href="{{ link(f=other, c=part) }}">Nie działa? Spróbuj {{ formats[other].name }}</a></p>
{% else %}<div class="e">{{ status.message }}</div>
{% if status.blocked %}<a class="b" href="{{ referer or src }}">Otwórz bezpośrednio w Operze</a>
<p><a href="{{ link(f=fmt, c=part, znowu=1) }}">Spróbuj ponownie w Szukajce</a></p>
{% else %}<a class="b" href="{{ link(f=fmt, c=part, znowu=1) }}">Spróbuj ponownie</a>
{% endif %}
<p><a href="{{ link(f=other, c=part) }}">Spróbuj {{ formats[other].name }}</a></p>
{% endif %}</div>
<div class="f"><a href="{{ src }}">[Oryginał filmu]</a></div>
{% endblock %}
""",
    "error.html": """{% extends "base.html" %}
{% block title %}Błąd{% endblock %}
{% block body %}{% include "_nav.html" %}<div class="w">
<div class="e">{{ message }}</div>
{% if original and blocked %}<a class="b" href="{{ original }}">Otwórz bezpośrednio w Operze</a>
<p class="m">Opera Mini otworzy pełną wersję strony przez własne serwery, które strony często wpuszczają.</p>
<p><a href="{{ retry }}">Spróbuj ponownie w Szukajce</a></p>
{% elif original %}<a class="b" href="{{ retry }}">Spróbuj ponownie</a>
<p><a href="{{ original }}">[Oryginał]</a></p>
{% endif %}</div>
{% endblock %}
""",
}


# Link wpisany w pole wyszukiwania: pełny adres, www.… albo domena ze znaną końcówką (np. rp.pl, onet.pl/sport).
LINK_QUERY = re.compile(
    r"^(?:https?://\S+|www\.\S+\.\S+|(?:[a-z0-9-]+\.)+(?:pl|com|net|org|eu|info|io|tv|fm|de|uk|co|me|gov|edu|app|dev|"
    r"biz|news|online|site|xyz|cz|sk|ua|fr|it|es|nl|ru|us|ca|au)(?::\d+)?(?:[/?#]\S*)?)$",
    re.I,
)


def fold(text):
    """Małe litery bez polskich (i innych) znaków diakrytycznych – znak w znak, więc pozycje zgadzają się z oryginałem."""
    out = []
    for char in text:
        low = char.lower()[:1] or char
        if low == "ł":
            out.append("l")
        else:
            out.append(unicodedata.normalize("NFKD", low)[:1] or low)
    return "".join(out)


def find_in_article(article, phrase):
    """Fragmenty artykułu z szukanym słowem: [{page, before, match, after, href, heading}] i łączna liczba trafień."""
    needle = fold(phrase)
    hits, total = [], 0
    for number, page in enumerate(article["pages"], 1):
        for kind, text, href in page:
            if kind not in ("h", "p"):
                continue
            hay = fold(text)
            pos = hay.find(needle)
            if pos < 0:
                continue
            total += hay.count(needle)
            if len(hits) >= FIND_MAX_HITS:
                continue
            end_match = pos + len(needle)
            while pos > 0 and text[pos - 1].isalnum():  # zaznaczamy całe słowo („lodz” -> „Łodzi”)
                pos -= 1
            while end_match < len(text) and text[end_match].isalnum():
                end_match += 1
            start, end = max(0, pos - 70), min(len(text), end_match + 110)
            if start > 0:
                space = text.find(" ", start, pos)
                start = space + 1 if space >= 0 else start
            if end < len(text):
                space = text.rfind(" ", end_match, end)
                end = space if space > 0 else end
            hits.append({
                "page": number, "href": href, "heading": kind == "h",
                "before": ("…" if start > 0 else "") + text[start:pos].lstrip("• "),
                "match": text[pos:end_match], "after": text[end_match:end] + ("…" if end < len(text) else ""),
            })
    return hits, total


def page_items(blocks):
    """Bloki jednej strony czytnika -> elementy do wyświetlenia. Miniatura stojąca tuż przed tytułem-linkiem
    trafia obok niego (jeden wiersz listy), a każdy blok-link staje się wierszem listy."""
    items, thumb = [], None
    for kind, text, href in blocks:
        if kind == "thumb":
            thumb = href  # czeka na swój tytuł; bez tytułu zostaje pominięta
            continue
        if href and kind in ("h", "p"):
            items.append({"kind": "item", "text": text[2:] if text.startswith("• ") else text, "href": href, "img": thumb})
        else:
            items.append({"kind": kind, "text": text, "href": href})
        thumb = None
    return items


app = Flask(__name__)
app.jinja_loader = DictLoader(TEMPLATES)
app.jinja_env.globals["style"] = STYLE
app.jinja_env.filters["mmss"] = mmss
app.jinja_env.filters["mb"] = megabytes


def video_items(article):
    """Filmy dla czytnika: adres, miniatura podana przez stronę i zdjęcie strony jako zapasowa miniatura."""
    posters = article.get("posters") or {}
    return [{"url": v, "poster": posters.get(v), "fallback": posters.get("")} for v in article.get("videos", [])]


@app.route("/")
def home():
    return render_template("home.html", q="")


@app.route("/search")
def search():
    query = squash(request.args.get("q", ""))[:200]
    if not query:
        return redirect(url_for("home"))
    if LINK_QUERY.match(query) and not request.args.get("w"):
        return redirect(url_for("read", url=query, q=query, rp=1, l=1))  # dokładny link – od razu otwieramy stronę
    page = clamp_int(request.args.get("p"), 1, 1, MAX_RESULT_PAGES)
    error, results, has_more = None, [], False
    try:
        results, has_more = ddg_search(query, page)
    except FetchError as err:
        error = err.message
    items = [dict(r, host=host_of(r["url"])) for r in results]
    body = render_template(
        "search.html", q=query, page=page, offset=(page - 1) * RESULTS_PER_PAGE,
        results=items, has_more=has_more, error=error,
    )
    return body, (502 if error else 200)


@app.route("/read")
def read():
    url = (request.args.get("url") or "").strip()
    query = squash(request.args.get("q", ""))[:200]
    results_page = clamp_int(request.args.get("rp"), 1, 1, MAX_RESULT_PAGES)
    page = clamp_int(request.args.get("page"), 1, 1, 1000)
    if not url:
        return redirect(url_for("home"))
    if not re.match(r"^https?://", url, re.I):
        url = "http://" + url
    common = {"q": query, "rp": results_page}
    if len(url) > MAX_URL_LENGTH:
        return render_template("error.html", message="Adres jest za długi.", original=None, **common), 400
    try:
        article = get_article(url)
    except VideoLink as found:
        return redirect(url_for("video", u=found.url, q=query or None, rp=results_page))
    except FetchError as err:
        return render_template("error.html", message=err.message, original=url, retry=request.full_path, blocked=err.blocked,
                               **common), err.status
    pages = article["pages"]
    phrase = squash(request.args.get("s", ""))[:100]
    if phrase:  # szukanie na tej stronie
        hits, total = find_in_article(article, phrase)
        count = max(1, -(-len(hits) // FIND_PER_PAGE))
        find_page = clamp_int(request.args.get("sp"), 1, 1, count)
        return render_template(
            "find.html", title=article["title"], url=url, original=article["url"], host=host_of(article["url"]), s=phrase,
            fixed_url=url, hits=hits[(find_page - 1) * FIND_PER_PAGE:find_page * FIND_PER_PAGE], total=total,
            sp=find_page, pages=count, **common,
        )
    page = min(page, len(pages))
    parts = urlparse(article["url"])
    return render_template(
        "read.html", title=article["title"], url=url, original=article["url"], host=host_of(article["url"]),
        items=page_items(pages[page - 1]), page=page, pages=len(pages), images=images_enabled(),
        has_images=any(b[0] in ("img", "thumb") for p in pages for b in p), site=f"{parts.scheme}://{parts.netloc}",
        videos=video_items(article), **common,
    )


@app.route("/film")
def video():
    """Film dla telefonu: wybór formatu, postęp przygotowania i link do gotowego pliku."""
    src = (request.args.get("u") or "").strip()
    referer = (request.args.get("r") or "").strip()
    query = squash(request.args.get("q", ""))[:200]
    results_page = clamp_int(request.args.get("rp"), 1, 1, MAX_RESULT_PAGES)
    fmt = request.args.get("f")
    part = clamp_int(request.args.get("c"), 1, 1, VIDEO_MAX_PARTS)
    common = {"q": query, "rp": results_page}
    if not re.match(r"^https?://", src, re.I) or len(src) > MAX_URL_LENGTH:
        return render_template("error.html", message="Nieprawidłowy adres filmu.", original=None, **common), 400
    if not re.match(r"^https?://", referer, re.I) or len(referer) > MAX_URL_LENGTH:
        referer = ""
    title = squash(request.args.get("t", ""))[:200] or "Film"
    poster = (request.args.get("p") or "").strip()[:MAX_URL_LENGTH]
    fallback = (request.args.get("fb") or "").strip()[:MAX_URL_LENGTH]
    site_url = urlparse(referer or src)

    def link(**changes):
        args = {"u": src, "r": referer or None, "t": title if title != "Film" else None, "q": query or None, "rp": results_page,
                "p": poster or None, "fb": fallback or None}
        args.update(changes)
        return url_for("video", **args)

    poster_img = url_for("image", u=src, v=1, p=poster or None, f=fallback or None,
                         r=f"{site_url.scheme}://{site_url.netloc}") if images_enabled() else None
    page = dict(src=src, referer=referer, title=title, host=host_of(src), part=part, formats=VIDEO_FORMATS, poster_img=poster_img,
                part_seconds=VIDEO_PART_SECONDS, part_minutes=VIDEO_PART_SECONDS // 60, link=link, status=None, **common)
    os.makedirs(VIDEO_DIR, exist_ok=True)
    if fmt not in VIDEO_FORMATS:
        ready = {f: (read_status(video_key(src, f, part - 1)) or {}).get("state") == "done" for f in VIDEO_FORMATS}
        return render_template("film.html", mode="choose", ready=ready, **page)
    key = video_key(src, fmt, part - 1)
    here = link(f=fmt, c=part)
    page.update(fmt=fmt, fmt_name=VIDEO_FORMATS[fmt]["name"], other="3gp" if fmt == "mp4" else "mp4", key=key, here=here)
    status = read_status(key)
    if status is None or (status.get("state") == "error" and request.args.get("znowu")):
        if not start_video_job(key, src, referer, fmt, part - 1):
            return render_template("film.html", mode="busy", refresh=15, **page)
        status = read_status(key) or {"state": "download", "got": 0, "progress": 0}
    page["status"] = status
    state = status.get("state")
    if state in VIDEO_ACTIVE:
        return render_template("film.html", mode="work", refresh=8, **page)
    return render_template("film.html", mode="done" if state == "done" else "error", **page)


@app.route("/film/<key>.<ext>")
def video_file(key, ext):
    """Gotowy plik filmu (z obsługą wznawiania pobierania – nagłówek Range)."""
    if not re.fullmatch(r"[0-9a-f]{32}", key) or ext not in VIDEO_FORMATS:
        abort(404)
    path = video_path(f"{key}.{ext}")
    if not os.path.isfile(path):
        abort(404)
    return send_file(
        path, mimetype=VIDEO_FORMATS[ext]["mime"], conditional=True, as_attachment=request.args.get("d") == "1",
        download_name=f"film-{key[:6]}.{ext}", max_age=VIDEO_KEEP_SECONDS,
    )


@app.route("/img")
def image():
    """Obrazek z artykułu zmniejszony dla telefonu. r = adres serwisu (Referer – część serwerów obrazków go wymaga)."""
    url = (request.args.get("u") or "").strip()
    referer = (request.args.get("r") or "").strip()
    thumb = request.args.get("t") == "1"  # miniatura ze strony z listą artykułów
    hq = request.args.get("hq") == "1"  # powiększenie otwierane z czytnika
    if not re.match(r"^https?://", url, re.I) or len(url) > MAX_URL_LENGTH:
        return Response("", status=400)
    if request.args.get("v") == "1":
        return video_poster_response(url, referer)
    mode = "hq" if hq else thumb
    data = image_cache.get((url, mode))
    if data is None:
        headers = {"Accept": "image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8"}
        if re.match(r"^https?://[^/\s]+$", referer):
            headers["Referer"] = referer + "/"
        try:
            resp = None
            bigger = hq_variant(url) if hq else None
            if bigger:  # Wikimedia: ta sama fotografia w większym rozmiarze
                _, resp = http_request(bigger, extra_headers=headers)
                if resp.status_code >= 400 or not resp.headers.get("Content-Type", "").lower().startswith("image/"):
                    resp.close()
                    resp = None
            if resp is None:
                _, resp = http_request(url, extra_headers=headers)
            if resp.status_code >= 400 or not resp.headers.get("Content-Type", "").lower().startswith("image/"):
                resp.close()
                return Response("", status=404)
            if hq:
                data = shrink_image(read_body(resp, limit=IMAGE_HQ_MAX_BYTES), IMAGE_HQ_WIDTH, IMAGE_HQ_HEIGHT, IMAGE_HQ_QUALITY)
            else:
                size = (THUMB_MAX_SIZE, THUMB_MAX_SIZE) if thumb else (IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT)
                data = shrink_image(read_body(resp, limit=IMAGE_MAX_BYTES), *size)
        except FetchError as err:
            return Response("", status=err.status)
        if data is None:
            return Response("", status=404)
        image_cache.set((url, mode), data)
    return Response(data, mimetype="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})


WIKIMEDIA_THUMB = re.compile(r"^(https://(?:upload|thumb)\.wikimedia\.org/.+/thumb/.+/)(\d+)px-([^/]+)$")


def hq_variant(url):
    """Większa wersja tego samego obrazka, gdy serwis ją udostępnia (Wikimedia: miniatury w stałych szerokościach)."""
    match = WIKIMEDIA_THUMB.match(url)
    if match and int(match.group(2)) < 960:
        return f"{match.group(1)}960px-{match.group(3)}"
    return None


def video_poster_response(url, referer):
    """/img?v=1: miniatura filmu u. p = miniatura podana przez stronę, f = zdjęcie strony (zapasowe)."""
    poster = (request.args.get("p") or "").strip()
    fallback = (request.args.get("f") or "").strip()
    site = referer if re.match(r"^https?://[^/\s]+$", referer) else ""
    key = ("film", url, poster, fallback)
    data = image_cache.get(key)
    if data is None:
        data = None
        if re.match(r"^https?://", poster, re.I) and len(poster) <= MAX_URL_LENGTH:
            data = fetch_image(poster, site, VIDEO_POSTER_SIZE)
        if data is None:
            try:
                data = video_poster(url, site)
            except Exception:
                log.exception("miniatura filmu: %s", url)
        if data is None and re.match(r"^https?://", fallback, re.I) and len(fallback) <= MAX_URL_LENGTH:
            data = fetch_image(fallback, site, VIDEO_POSTER_SIZE)
        data = add_play_icon(data) if data else b""
        image_cache.set(key, data)  # także porażkę – nie szukamy drugi raz
    if not data:
        return Response("", status=404)
    return Response(data, mimetype="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})


@app.route("/obrazki")
def toggle_images():
    """Włącza/wyłącza obrazki w czytniku (zapamiętane w ciasteczku na rok) i wraca na tę samą stronę."""
    target = request.args.get("next") or "/"
    if not target.startswith("/") or target.startswith("//"):
        target = "/"  # tylko adresy w tej aplikacji
    resp = redirect(target)
    resp.set_cookie("obrazki", "0" if request.args.get("wl") == "0" else "1", max_age=365 * 24 * 3600, samesite="Lax")
    return resp


DIAG_TARGETS = [("example.com", 443), ("lite.duckduckgo.com", 443), ("frogfind.com", 80), ("1.1.1.1", 443)]  # stała lista


@app.route("/diag")
def diag():
    """Diagnostyka sieci serwera (DNS i połączenia TCP przez IPv4 i IPv6) – zwykły tekst, do szukania przyczyny timeoutów."""
    lines = [f"FORCE_IPV4={FORCE_IPV4}"]
    proxy_vars = sorted(k for k in os.environ if k.lower() in ("http_proxy", "https_proxy", "all_proxy", "no_proxy"))
    lines.append("zmienne proxy: " + (", ".join(proxy_vars) if proxy_vars else "brak"))
    for host, port in DIAG_TARGETS:
        for family, name in ((socket.AF_INET, "IPv4"), (socket.AF_INET6, "IPv6")):
            started = time.monotonic()
            try:
                addrs = sorted({i[4][0] for i in socket.getaddrinfo(host, port, family, socket.SOCK_STREAM)})
            except socket.gaierror as err:
                lines.append(f"{host} {name}: DNS brak adresu ({err.strerror})")
                continue
            dns_ms = int((time.monotonic() - started) * 1000)
            sock = socket.socket(family, socket.SOCK_STREAM)
            sock.settimeout(3)
            started = time.monotonic()
            try:
                sock.connect((addrs[0], port))
                result = "OK"
            except OSError as err:
                result = f"BŁĄD {type(err).__name__}"
            finally:
                sock.close()
            tcp_ms = int((time.monotonic() - started) * 1000)
            lines.append(f"{host}:{port} {name} {addrs[0]}: DNS {dns_ms} ms, TCP {result} {tcp_ms} ms")
    started = time.monotonic()
    try:  # FrogFind: czy odpowiada i czy na jego stronie są wyniki (stałe hasło testowe)
        resp = requests.get(FROGFIND, params={"q": "wikipedia"}, timeout=(5, 15), headers={"User-Agent": FROGFIND_UA})
        body = resp.content.decode("utf-8", errors="replace")
        text = squash(BeautifulSoup(body, "lxml").get_text(" "))
        lines.append(f"frogfind 'wikipedia': HTTP {resp.status_code}, {len(body)} B, linków read: "
                     f"{body.count('read?a=') + body.count('read.php?a=')}, wyników odczytanych: {len(parse_frogfind(body))}, "
                     f"{int((time.monotonic() - started) * 1000)} ms")
        hrefs = [a["href"][:80] for a in BeautifulSoup(body, "lxml").find_all("a", href=True)][:4]
        lines.append(f"frogfind linki: {hrefs}")
        lines.append(f"frogfind tekst: {text[:300]}")
    except requests.exceptions.RequestException as err:
        lines.append(f"frogfind: BŁĄD {type(err).__name__} {int((time.monotonic() - started) * 1000)} ms")
    started = time.monotonic()
    try:
        resp = requests.get("https://example.com/", timeout=(5, 5), headers={"User-Agent": USER_AGENT})
        result = f"HTTP {resp.status_code}"
    except requests.exceptions.RequestException as err:
        result = f"BŁĄD {type(err).__name__}"
    lines.append(f"requests example.com: {result} {int((time.monotonic() - started) * 1000)} ms")
    return Response("\n".join(lines) + "\n", mimetype="text/plain")


@app.route("/healthz")
def healthz():
    return "ok"


@app.route("/robots.txt")
def robots():
    return Response("User-agent: *\nDisallow: /\n", mimetype="text/plain")


@app.errorhandler(404)
def not_found(_err):
    return render_template("error.html", message="Nie ma takiej strony.", original=None, q="", rp=1), 404


@app.errorhandler(500)
def server_error(_err):
    return render_template("error.html", message="Wystąpił błąd serwera. Spróbuj ponownie.", original=None, q="", rp=1), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")))
