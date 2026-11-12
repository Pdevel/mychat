"""Ultralekka wyszukiwarka i czytnik stron dla Opera Mini na telefonach z klawiaturą
(Nokia 235 4G / Nokia 3210 4G: ekran 2,4–2,8" 240×320, UNISOC T107, 64 MB RAM, 128 MB pamięci, bez dotyku).

Strony to czysty HTML: bez CSS, bez JavaScriptu, z jak najmniejszą liczbą linków przed treścią,
żeby wygodnie przechodzić po nich samymi strzałkami.

  /        – formularz wyszukiwania
  /search  – wyniki z DuckDuckGo Lite (region polski), 10 na stronę. Gdy DuckDuckGo blokuje serwer (np. na Render.com),
             wyniki przychodzą przez FrogFind (frogfind.com – prosta nakładka na DuckDuckGo, bez klucza API);
             opcjonalnie jeszcze Brave Search API (klucz w zmiennej BRAVE_API_KEY)
  /read    – czytnik: pobiera stronę, zostawia sam tekst (tytuł, nagłówki, akapity) i dzieli go na strony
  /film    – filmy ze stron przekodowane dla telefonu (MP4 H.264 320×240 albo 3GP H.263 176×144)
"""

import base64
import collections
import hashlib
import io
import ipaddress
import json
import logging
import os
import pickle
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unicodedata
import uuid
import zlib
from collections import OrderedDict
from html import unescape
from urllib.parse import parse_qs, quote, unquote, urljoin, urlparse

import requests
import urllib3.util.connection as urllib3_connection
from bs4 import BeautifulSoup, SoupStrainer
from bs4.element import CData, NavigableString, Tag
from markupsafe import Markup, escape
from flask import Flask, Response, abort, make_response, redirect, render_template, request, send_file, url_for
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
# Nokia 3210 4G / 235 4G ma 64 MB RAM: powiększenie to najwyżej ok. 1 mln pikseli (≤ 3,8 MB po rozpakowaniu),
# 2× szerokość ekranu 240 px – wyraźnie ostrzejsze, a wciąż bezpieczne dla pamięci telefonu.
IMAGE_HQ_WIDTH = int(os.environ.get("IMAGE_HQ_WIDTH", "480"))
IMAGE_HQ_HEIGHT = 2000  # wysokie obrazki (np. strony komiksu) zostają czytelne
IMAGE_HQ_QUALITY = int(os.environ.get("IMAGE_HQ_QUALITY", "65"))
IMAGE_HQ_MAX_BYTES = 10_000_000
IMAGE_MIN_SIZE = 48  # mniejsze to ikonki, flagi i piksele śledzące – na ekranie 240 px to tylko szum
IMAGES_PER_ARTICLE = 12  # więcej obrazków to zbyt dużo danych i pracy dla telefonu i darmowego serwera
GALLERY_MAX = 60  # obrazków z galerii (np. strony komiksu, zdjęcia z relacji) na jedną stronę serwisu
IMAGE_WEIGHT = 600  # obrazek zajmuje na stronie czytnika tyle „znaków” z limitu ARTICLE_PAGE_CHARS
# Miniatury na stronach z listą artykułów (np. główna serwisu): mniejsze i lżejsze niż zdjęcia w artykule.
THUMB_MAX_SIZE = int(os.environ.get("THUMB_MAX_SIZE", "80"))  # najdłuższy bok miniatury w px (stoi obok tytułu)
THUMBS_PER_LISTING = 30
THUMB_WEIGHT = 300  # ok. 10 miniatur na jedną stronę czytnika
# Galeria (kilka obrazków z rzędu, np. strony komiksu, zdjęcia z relacji): po dwa obok siebie, jak w oryginale.
GRID_IMAGE_SIZE = (160, 240)  # najdłuższe boki obrazka w siatce; kliknięcie otwiera pełny obrazek
GRID_WEIGHT = 300  # ok. 10 obrazków galerii na jedną stronę czytnika
Image.MAX_IMAGE_PIXELS = 25_000_000  # ochrona przed „bombami” (ogromne wymiary w małym pliku)

# Filmy: serwer pobiera plik (albo strumień HLS .m3u8), przekodowuje go ffmpegiem do małego pliku, który odtwarzacz
# wideo Nokii 235 4G / 3210 4G udźwignie, i podaje go do pobrania. Długie filmy dzielimy na części.
VIDEO_DIR = os.environ.get("VIDEO_DIR") or os.path.join(tempfile.gettempdir(), "szukajka-filmy")
VIDEO_PART_SECONDS = int(os.environ.get("VIDEO_PART_MINUTES", "15")) * 60  # długość dalszych części filmu
# Pierwsze części są krótsze, żeby oglądanie zaczęło się szybko: 3 min są gotowe po ok. minucie nawet na słabym serwerze.
# Każda następna jest najwyżej 2× dłuższa, więc przygotowana w tle zdąży, zanim skończy się oglądanie poprzedniej.
VIDEO_FIRST_PARTS = [int(m) * 60 for m in os.environ.get("VIDEO_FIRST_PARTS_MINUTES", "3,6,12").split(",") if m.strip()]
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
PROBE_WAIT = float(os.environ.get("PROBE_WAIT", "2.0"))  # tyle s najwyżej czekamy przy szukaniu na sprawdzenie, czy strony z wyników nie blokują serwera
PREFETCH_RESULTS = int(os.environ.get("PREFETCH_RESULTS", "2"))  # tyle pierwszych wyników wczytujemy z wyprzedzeniem
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


class DiskCache:
    """Pamięć podręczna na dysku (pliki w katalogu tymczasowym) – wspólna dla wszystkich procesów Gunicorna, więc wynik
    zapamiętany przez jeden proces jest gotowy także w drugim. Przed nią stoi szybka pamięć TTLCache w procesie."""

    def __init__(self, name, ttl, max_files):
        self.dir = os.path.join(CACHE_DIR, name)
        self.ttl, self.max_files, self.writes = ttl, max_files, 0
        self.memory = TTLCache(maxsize=50, ttl=ttl)

    def path(self, key):
        return os.path.join(self.dir, hashlib.sha1(repr(key).encode("utf-8")).hexdigest() + ".pkl")

    def get(self, key):
        value = self.memory.get(key)
        if value is not None:
            return value
        path = self.path(key)
        try:
            if time.time() - os.path.getmtime(path) > self.ttl:
                return None
            with open(path, "rb") as handle:
                value = pickle.load(handle)  # tylko nasze własne pliki w katalogu tymczasowym aplikacji
        except (OSError, EOFError, pickle.PickleError, AttributeError, ValueError):
            return None
        self.memory.set(key, value)
        return value

    def set(self, key, value):
        self.memory.set(key, value)
        try:
            os.makedirs(self.dir, exist_ok=True)
            tmp = f"{self.path(key)}.{uuid.uuid4().hex}.tmp"
            with open(tmp, "wb") as handle:
                pickle.dump(value, handle, protocol=pickle.HIGHEST_PROTOCOL)
            os.replace(tmp, self.path(key))
        except OSError as err:
            log.info("pamięć podręczna na dysku: %s", err)
            return
        self.writes += 1
        if self.writes % 25 == 0:
            self.trim()

    def trim(self):
        try:
            files = sorted((os.path.getmtime(os.path.join(self.dir, n)), n) for n in os.listdir(self.dir))
        except OSError:
            return
        now = time.time()
        for index, (mtime, name) in enumerate(files):
            if now - mtime > self.ttl or index < len(files) - self.max_files:
                try:
                    os.remove(os.path.join(self.dir, name))
                except OSError:
                    pass


CACHE_DIR = os.environ.get("CACHE_DIR") or os.path.join(tempfile.gettempdir(), "szukajka-cache")
search_cache = DiskCache("wyniki", ttl=1800, max_files=500)  # wyniki wyszukiwania: 30 min
article_cache = DiskCache("strony", ttl=900, max_files=200)  # przeczytane strony: 15 min
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


# Znaczniki, które w przeglądarce zaczynają nową linię/komórkę – tylko tam wstawiamy odstęp. Między zwykłymi
# znacznikami w tekście (<a>, <b>, <span>…) odstępu nie dokładamy, więc nie ma „Polska , Rzeczpospolita”.
TEXT_BREAKS = {"br", "p", "div", "li", "td", "th", "tr", "dt", "dd", "ul", "ol", "table", "blockquote", "pre",
               "section", "article", "h1", "h2", "h3", "h4", "h5", "h6", "figcaption", "caption", "hr"}


GLUE_TAGS = {"span", "a", "time", "small", "label", "strong", "b", "em", "i", "button", "abbr"}


def glued(previous, child):
    """Dwa elementy w linii stojące tuż obok siebie (bez tekstu między nimi), np. <span>TV</span><span>SS 1</span>:
    strony rozsuwają je stylem CSS, więc w tekście potrzebny jest odstęp (ale nie przed znakiem interpunkcyjnym)."""
    if not isinstance(previous, Tag) or previous.name not in GLUE_TAGS or child.name not in GLUE_TAGS:
        return False
    text = child.get_text()
    return bool(text) and text[0].isalnum()


def node_text(node):
    if node is None:
        return ""
    parts = []

    def walk(current):
        previous = None
        for child in current.children:
            if type(child) in (NavigableString, CData):
                parts.append(str(child))
            elif isinstance(child, Tag):
                breaks = child.name in TEXT_BREAKS
                if breaks or glued(previous, child):
                    parts.append(" ")
                walk(child)
                if breaks:
                    parts.append(" ")  # odstęp także po elemencie blokowym („Tytuł” + „2026”)
            previous = child

    if isinstance(node, Tag):
        walk(node)
    else:
        parts.append(str(node))
    return squash("".join(parts))


# Akapit z linkami w tekście: link zapisany w tekście bloku jako \x01adres\x02tekst\x03 (rodzaj bloku "pl").
LINK_MARK = re.compile(r"\x01([^\x02]*)\x02([^\x03]*)\x03")


def visible(text):
    """Tekst bloku bez zapisanych w nim adresów linków."""
    return LINK_MARK.sub(lambda m: m.group(2), text) if "\x01" in text else text


def node_segments(node, base_url):
    """Tekst węzła z linkami w środku (zapis jak w LINK_MARK) i liczba linków."""
    parts, count = [], 0

    def walk(current):
        nonlocal count
        previous = None
        for child in current.children:
            earlier, previous = previous, child
            if type(child) in (NavigableString, CData):
                parts.append(str(child).replace("\x01", "").replace("\x02", "").replace("\x03", ""))
            elif isinstance(child, Tag):
                if child.name in TEXT_BREAKS or glued(earlier, child):
                    parts.append(" ")
                if child.name == "a" and child.get("href"):
                    href = urljoin(base_url, child["href"].strip())
                    text = node_text(child)
                    if text and urlparse(href).scheme in ("http", "https") and href.split("#")[0] != base_url.split("#")[0]:
                        parts.append(f"\x01{href}\x02{text}\x03")
                        count += 1
                        continue
                walk(child)
                if child.name in TEXT_BREAKS:
                    parts.append(" ")

    walk(node)
    return " ".join("".join(parts).split()), count


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


DDG_STATE = os.path.join(CACHE_DIR, "duckduckgo.json")
DDG_BACKOFF_MAX = 6 * 3600


def ddg_blocked():
    """Czy DuckDuckGo jest w przerwie po porażkach (stan wspólny dla procesów serwera)."""
    try:
        with open(DDG_STATE, encoding="utf-8") as handle:
            return time.time() < json.load(handle).get("down_until", 0)
    except (OSError, ValueError):
        return False


def ddg_failed():
    """Zapisuje porażkę; każda kolejna wydłuża przerwę 2× (10 min, 20 min, 40 min… do 6 h). Zwraca długość przerwy."""
    try:
        with open(DDG_STATE, encoding="utf-8") as handle:
            failures = json.load(handle).get("failures", 0) + 1
    except (OSError, ValueError):
        failures = 1
    pause = min(DDG_BACKOFF * 2 ** (failures - 1), DDG_BACKOFF_MAX)
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        tmp = f"{DDG_STATE}.{uuid.uuid4().hex}.tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump({"failures": failures, "down_until": time.time() + pause}, handle)
        os.replace(tmp, DDG_STATE)
    except OSError:
        pass
    return pause


def ddg_succeeded():
    try:
        os.remove(DDG_STATE)
    except OSError:
        pass


_prefetching = threading.Lock()


def prefetch_articles(urls):
    """Wczytuje w tle pierwsze wyniki do pamięci podręcznej – kliknięty wynik otwiera się od razu."""
    def run():
        if not _prefetching.acquire(blocking=False):
            return  # inne wczytywanie z wyprzedzeniem już trwa
        _render_local.background = True  # nie czeka w kolejce Cloudflare – to tylko przyspieszenie
        try:
            for url in urls:
                if article_cache.get(url) is None:
                    try:
                        get_article(url)
                    except (FetchError, VideoLink):
                        pass
                    except Exception:
                        log.exception("wczytywanie z wyprzedzeniem: %s", url)
        finally:
            _prefetching.release()

    threading.Thread(target=run, daemon=True).start()


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
    if time.monotonic() < ddg_down_until or ddg_blocked():
        endpoints = ()  # DuckDuckGo niedawno zawiódł – od razu źródło zapasowe
    for endpoint, parser in endpoints:
        try:
            _, resp = http_request(endpoint, method="POST", data=form)
            status = resp.status_code
            html = decode_html(read_body(resp, limit=800_000), resp)
        except FetchError as err:
            last_error = unreachable if err.status in (502, 504) else err
            ddg_down_until = time.monotonic() + ddg_failed()
            break  # drugi adres DuckDuckGo i tak zawiedzie tak samo – nie tracimy czasu
        if status != 200 or looks_blocked(html):
            log.warning("DuckDuckGo odrzucił zapytanie (%s, status %s)", endpoint, status)
            ddg_down_until = time.monotonic() + ddg_failed()
            last_error = FetchError(
                "Wyszukiwarka chwilowo nie przyjmuje zapytań z tego serwera. Spróbuj za kilka minut.", 503
            )
            continue
        results = dedupe(parser(html))
        if results or says_no_results(html):
            ddg_succeeded()
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


TITLE_HINT = re.compile(r"title|name|heading|headline|tytul|nazwa", re.I)
BACKGROUND_URL = re.compile(r"background(?:-image)?\s*:[^;]*url\(\s*['\"]?([^'\")\s]+)", re.I)
HEADINGS = ("h1", "h2", "h3", "h4", "h5", "h6")


def no_urls(text):
    """Tekst bez adresów (strony trzymają czasem adres obrazka jako ukryty tekst w kafelku)."""
    return squash(re.sub(r"\S*(?:https?://|www\.)\S+", " ", text)) if ("://" in text or "www." in text) else text


def text_parts(node):
    """Kawałki tekstu węzła rozdzielone granicami elementów blokowych: [(tekst, element_z_tym_tekstem)].
    Dla kafelka to np. [("TV SS 1 EP 5", <div.meta>), ("Afro Samurai", <h3>)]."""
    parts, current, holder = [], [], [None]

    def flush():
        text = squash("".join(current))
        if text:
            parts.append((text, holder[0]))
        current.clear()
        holder[0] = None

    def walk(element):
        previous = None
        for child in element.children:
            if type(child) in (NavigableString, CData):
                if holder[0] is None and str(child).strip():
                    holder[0] = element  # najgłębszy element z początkiem tego tekstu (np. <a class="name">)
                current.append(str(child))
            elif isinstance(child, Tag) and child.name not in ("script", "style", "noscript"):
                if child.name in TEXT_BREAKS:
                    flush()
                    walk(child)
                    flush()
                else:
                    if glued(previous, child):
                        current.append(" ")
                    walk(child)
            previous = child

    walk(node)
    flush()
    return parts


def meta_like(text):
    """Linijka danych, a nie tytuł: sporo cyfr („Movie 2026 107 min”, „TV SS 1 EP 5”, „8,77”) albo prawie bez liter."""
    digits = sum(char.isdigit() for char in text)
    return letters(text) < 3 or digits >= 0.2 * (letters(text) + digits)


def title_hinted(holder, stop):
    element = holder
    while element is not None:
        if element.name in HEADINGS or TITLE_HINT.search(" ".join(element.get("class") or [])):
            return True
        if element is stop:
            break
        element = element.parent
    return False


def pick_title(parts, container):
    """Który kawałek kafelka jest tytułem: nie linijka danych; najlepiej nagłówek albo klasa typu title/name;
    inaczej pierwszy kawałek z co najmniej dwoma słowami (nie etykieta działu typu „KRAJ”). None, gdy same dane."""
    hinted = [part for part in parts if part[1] is not None and letters(part[0]) >= 1 and title_hinted(part[1], container)]
    if hinted:
        return hinted[0][0]  # także tytuły z cyframi („Apollo 13”), gdy strona oznacza je jako tytuł
    candidates = [part for part in parts if not meta_like(part[0])]
    if not candidates:
        return None
    solid = [part for part in candidates if len(part[0].split()) >= 2 or letters(part[0]) >= 12]
    return (solid or candidates)[0][0]


def card_container(link, href, base_url, root):
    """Najwyższy element (do 4 poziomów w górę), w którym wszystkie linki prowadzą pod ten sam adres – cały kafelek,
    gdy obrazek, dane i tytuł stoją obok siebie w osobnych znacznikach. Zbyt duży obszar (ponad 300 znaków) odrzucamy."""
    container, element = link, link.parent
    for _ in range(4):
        if element is None or element is root or element.name in ("body", "html", "[document]", "main", "ul", "ol", "table"):
            break
        targets = {card_link(a, base_url) for a in element.find_all("a", href=True)}
        if targets - {href, None} or len(element.get_text()) > 300:
            break
        container, element = element, element.parent
    return container


def card_image(container, base_url, check_size=True):
    """Obrazek kafelka: <img> albo tło CSS (style="background-image:url(…)", data-bg, data-background)."""
    img = container.find("img")
    if img is not None:
        return img, image_source(img, base_url, check_size)
    for element in [container] + container.find_all(True):
        value = element.get("data-bg") or element.get("data-background") or element.get("data-background-image")
        match = BACKGROUND_URL.search(element.get("style") or "")
        value = value or (match.group(1) if match else None)
        if value and not value.startswith("data:"):
            src = urljoin(base_url, value.strip())
            if urlparse(src).scheme in ("http", "https") and not urlparse(src).path.lower().endswith(".svg"):
                return None, src
    return None, None


def collect_blocks(root, base_url, with_images=False, skip_images=frozenset(), image_kind="img", max_images=IMAGES_PER_ARTICLE,
                   cards=False, inline_links=False, protected=None):
    """Zbiera z drzewa nagłówki i akapity w kolejności występowania, bez powtarzania zagnieżdżonych.
    Blok to (rodzaj, tekst, adres_linku_lub_None); ten sam adres linkujemy tylko raz.
    Z with_images=True dochodzą bloki (image_kind, opis, adres_obrazka) – najwyżej max_images
    ("img" – zdjęcie w artykule, "thumb" – miniatura na stronie z listą).
    cards=True (strony z listą): także „kafelki” – linki z obrazkiem i tytułem w zwykłym <div>/<span>, w title
    albo w alt obrazka (sklepy, katalogi, serwisy z przepisami…), które nie leżą w nagłówku ani akapicie."""
    blocks, linked, images = [], set(), set()
    consumed, card_hrefs, best_text, best_title = set(), set(), {}, {}
    if cards:  # najlepszy tytuł dla adresu: kafelek bywa obrazkiem-linkiem, a tytuł osobnym linkiem obok
        for link in root.find_all("a", href=True):
            href = card_link(link, base_url)
            if href:
                for candidate in (no_urls(node_text(link)), squash(link.get("title") or "")):
                    if letters(candidate) > letters(best_text.get(href, "")):
                        best_text[href] = candidate  # tytuł ma najwięcej liter (nie „8,77 10 988 tys. ocen”)
                if len(squash(link.get("title") or "")) > len(best_title.get(href, "")):
                    best_title[href] = squash(link["title"])
    tags = BLOCK_TAGS + (["img"] if with_images else []) + (["a"] if cards else [])
    for node in root.find_all(tags):
        if id(node) in consumed:
            continue  # część kafelka, który już pokazaliśmy
        if node.name == "a":
            if node.get("href") is None or any(parent.name in BLOCK_TAGS for parent in node.parents):
                continue
            href = card_link(node, base_url)
            if not href or href in linked:
                continue
            container = card_container(node, href, base_url, root)
            parts = [(no_urls(text), holder) for text, holder in text_parts(container)]
            parts = [part for part in parts if part[0]]
            img, src = card_image(container, base_url)
            has_image = img is not None or src is not None
            labeled = not has_image and (
                (2 <= len(parts) <= 3 and sum(1 for text, _ in parts if LABEL_PART.fullmatch(text)) == 1)
                or (len(parts) == 1 and LABEL_LEAD.match(parts[0][0]) is not None and len(parts[0][0]) <= 80))
            named = squash(node.get("title") or "") or best_title.get(href, "")
            elsewhere = best_text.get(href, "")  # tekst innego linku pod ten sam adres (np. tytuł obok obrazka-linku)
            known = [(elsewhere, None)] if elsewhere and not any(fold(elsewhere) in fold(text) for text, _ in parts) else []
            if labeled:  # „Country:” + „USA” – to dane, nie tytuł z dopiskiem: zostają w kolejności ze strony
                title, parts = " ".join(text for text, _ in parts), []
            elif named and len(named) >= 2:
                title = named  # atrybut title linku to zwykle pełny tytuł
            else:
                title = pick_title(parts + known, container)
            is_card = has_image or len(parts) >= 2 or labeled
            if title is None:  # same dane (np. „8,77 · 10 988 tys. ocen”) – zwykły link z tekstem w kolejności ze strony
                title = no_urls(node_text(container)) or (squash(img.get("alt") or "") if img is not None else "")
                is_card, parts = has_image, []
            if not ((is_card and len(title) >= 2) or len(title) >= 25 or len(title.split()) >= 4):
                continue  # „Więcej”, „Zobacz”, numery stron, pozycje menu…
            shown = fold(title)  # bez powtórzeń tytułu, także uciętego („Pełny tyt…”)
            extras = [text for text, _ in parts
                      if fold(text) not in shown and not shown.startswith(fold(text).rstrip(".… "))]
            for inner in container.find_all(BLOCK_TAGS + ["img"]):
                consumed.add(id(inner))
            if with_images and src and src not in images and src not in skip_images and len(images) < max_images:
                images.add(src)
                blocks.append((image_kind, "", src))
            linked.add(href)
            card_hrefs.add(href)
            if is_card and protected is not None:
                protected.add(href)
            short = " · ".join(extras)
            if extras and len(short) <= 60:
                blocks.append(("p", shorten(title, 160) + " · " + short, href))
            else:
                blocks.append(("p", shorten(title, 200), href))
                if extras:  # dłuższy opis pod tytułem (np. zajawka artykułu)
                    blocks.append(("p", shorten(" ".join(extras), 220), None))
            continue
        if node.name == "img":
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
                if protected is not None:
                    protected.add(href)
                for inner in node.find_all(BLOCK_TAGS + ["img"]):
                    consumed.add(id(inner))
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
            continue
        prefix = "• " if node.name == "li" else ""
        if inline_links and href is None:  # akapit artykułu z linkami w tekście, jak na oryginalnej stronie
            segments, count = node_segments(node, base_url)
            if count:
                blocks.append(("pl", prefix + segments, None))
                continue
        blocks.append(("p", prefix + text, href))
    return blocks


def is_menu_entry(block, protected=frozenset()):
    kind, text, href = block
    text = text[2:] if text.startswith("• ") else text
    return kind in ("p", "h") and href is not None and href not in protected and len(text) <= 25 and len(text.split()) <= 3


def drop_menus(blocks, run=6, protected=frozenset()):
    """Usuwa menu nieoznaczone jako <nav>: ciąg co najmniej `run` krótkich linków z rzędu (np. „Filmy”, „Seriale”,
    „Rankingi”…) bez obrazków. Na telefonie z klawiaturą to dziesiątki skoków strzałką przed treścią."""
    def neutral(block):  # krótki podpis bez linku (np. „Na VOD”) nie przerywa menu
        return block[0] in ("p", "h") and block[2] is None and len(block[1]) <= 25

    is_entry = lambda block: is_menu_entry(block, protected)  # kafelki (obrazek, dane obok tytułu) to treść, nie menu
    out, i = [], 0
    while i < len(blocks):
        j, links = i, 0
        while j < len(blocks) and (is_entry(blocks[j]) or (links and neutral(blocks[j]))):
            links += is_entry(blocks[j])
            j += 1
        while j > i and not is_entry(blocks[j - 1]):
            j -= 1  # podpis na końcu ciągu należy już do treści
        if links >= run:
            i = j  # menu – pomijamy cały ciąg
            continue
        out.extend(blocks[i:j] if j > i else blocks[i:i + 1])
        i = j if j > i else i + 1
    return out


WRAPPER_TAGS = {"form", "header", "aside", "nav", "menu", "dialog"}
WRAPPER_SHARE = 0.35  # element z taką częścią tekstu strony to jej „ramka”, a nie menu, reklama czy stopka


def fallback_blocks(soup, base_url, skip_images=frozenset()):
    """Strona z listą (albo gdy readability zawiedzie): usuń śmieci (skrypty, menu, reklamy…) i weź tekst
    z <article>/<main>/<body>. Elementów obejmujących dużą część strony nie usuwamy, nawet gdy wyglądają na
    „śmieci”: <form> wokół całej strony (ASP.NET), <aside> z listami, klasy typu „with-sidebar”, „header-fixed”."""
    for tag in soup(["script", "style", "noscript", "template"]):
        tag.decompose()
    total = max(len((soup.body or soup).get_text()), 1)
    big = lambda tag: len(tag.get_text()) > WRAPPER_SHARE * total
    for tag in soup(JUNK_TAGS):
        if tag.attrs is None:
            continue
        if tag.name in WRAPPER_TAGS and big(tag):
            tag.unwrap()
        else:
            tag.decompose()
    for tag in soup.find_all(True):
        if tag.attrs is None:
            continue
        # klasy BEM „blok__element” (np. card__header) to części kafelka, a nie nagłówek/stopka strony
        names = [c for c in (tag.get("class") or []) + [tag.get("id") or ""] if c and "__" not in c]
        hint = " ".join(names)
        if hint.strip() and JUNK_HINT.search(hint) and tag.name not in ("body", "html", "article", "main") and not big(tag):
            tag.decompose()
    body = soup.body or soup
    total = max(len(body.get_text()), 1)
    articles = soup.find_all("article")
    main = soup.find("main")
    if main is not None and (len(main.get_text()) > 0.5 * total or len(main.find_all("a", href=True)) >= 5):
        area = main  # główna część strony; poza nią są zwykle stopki z dziesiątkami linków
    else:
        area = body  # brak <main> albo jest prawie pusty – treść leży gdzie indziej
    if len(articles) == 1 and len(articles[0].get_text()) > 0.5 * len(area.get_text()):
        root = articles[0]
    else:  # wiele <article> to zwykle kafelki listy – bierzemy ich wspólny kontener, a nie pierwszy kafelek
        root = area
    protected = set()
    blocks = collect_blocks(
        root, base_url, with_images=True, skip_images=skip_images, image_kind="thumb", max_images=THUMBS_PER_LISTING,
        cards=True, protected=protected,
    )
    blocks = drop_menus(blocks, protected=protected)
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


INFOBOX_CLASS = re.compile(r"(^|[\s_-])(infobox|portable-infobox|ibox\d*|infotable|biota)([\s_-]|$)", re.I)
CLUTTER_CLASS = re.compile(
    r"(^|\s)(mw-editsection|navbox|vertical-navbox|mw-jump-link|catlinks|toc|reflist-hide|references|reflist|refbegin|"
    r"mw-references-wrap)(\s|$)", re.I
)
FOOTNOTE = re.compile(r"\[\s*[\w.,–-]{1,8}\s*\]")


def clean_document(soup, base_url):
    """Usuwa z dokumentu to, co na telefonie tylko przeszkadza: znaczniki przypisów („[1]”, „[a]”), linki „edytuj”,
    szablony nawigacyjne i spisy treści. Zwraca wiersze tabeli informacyjnej (infobox) jako [(etykieta, wartość)];
    sama tabela znika z treści – pokazujemy ją zwięźle po pierwszym akapicie, jak w mobilnej wersji serwisów."""
    for tag in soup(["script", "style", "svg", "template"]):
        tag.decompose()  # do treści niepotrzebne, a to często większość HTML – readability działa wtedy kilka razy szybciej
    for sup in soup.find_all("sup"):
        classes = " ".join(sup.get("class") or [])
        if "reference" in classes or (FOOTNOTE.fullmatch(sup.get_text("", strip=True)) and sup.find("a", href=re.compile(r"^#"))):
            sup.decompose()
    for tag in soup.find_all(True):
        if tag.attrs is not None and CLUTTER_CLASS.search(" ".join(tag.get("class") or []) + " " + (tag.get("id") or "")):
            tag.decompose()
    rows = []
    for box in soup.find_all(["table", "aside", "div"], class_=INFOBOX_CLASS):
        if box.attrs is None:
            continue  # już usunięte razem z nadrzędną tabelą
        caption = box.find("caption")
        if caption is not None and node_text(caption):
            rows.append({"t": shorten(node_text(caption), 80)})
        if box.name == "table":
            infobox_table_rows(box, base_url, rows)
        title = box.select_one(".pi-title")  # infobox z serwisów Fandom
        if title is not None:
            rows.append({"t": shorten(node_text(title), 80)})
        for figure in box.select(".pi-image"):
            images = infobox_images(figure, base_url)
            if images:
                rows.append({"img": [{"src": images[0], "cap": node_segments(figure, base_url)[0]}]})
        for item in box.select(".pi-data"):
            label, value = item.select_one(".pi-data-label"), item.select_one(".pi-data-value")
            if label and value and node_text(value):
                rows.append({"l": shorten(node_text(label), 40), "v": infobox_value(node_segments(value, base_url)[0])})
        box.decompose()
    return rows[:50]


BR_MARK = "\x04"


def infobox_images(cell, base_url):
    """Zdjęcia z komórki tabeli informacyjnej (bez ikonek, np. małych flag przy nazwie państwa)."""
    found = []
    for img in cell.find_all("img"):
        src = image_source(img, base_url, check_size=False)
        if src and not is_small_image(img) and src not in found:
            found.append(src)
    return found


def infobox_value(text):
    return text if len(visible(text)) <= 220 else shorten(visible(text), 220)


def cell_parts(cell, base_url):
    """Tekst komórki (z linkami) podzielony w miejscach <br> – np. „liczba ludności” i „gęstość” w jednej komórce."""
    if cell.find("br") is None:
        return [node_segments(cell, base_url)[0]]
    fragment = BeautifulSoup(re.sub(r"<br\s*/?>", BR_MARK, str(cell), flags=re.I), "lxml")
    text = node_segments(fragment.body or fragment, base_url)[0]
    return [" ".join(part.split()) for part in text.split(BR_MARK)]


def infobox_table_rows(table, base_url, rows):
    """Wiersze tabeli informacyjnej: tytuły, zdjęcia (z podpisami także z następnego wiersza), etykieta: wartość."""
    trs = [tr for tr in table.find_all("tr") if tr.find_parent("table") is table]
    has_headers = any(tr.find("th", recursive=False) is not None for tr in trs)
    index = 0
    while index < len(trs):
        cells = trs[index].find_all(["th", "td"], recursive=False)
        index += 1
        nested = [cell.find("table") for cell in cells if cell.find("table") is not None]
        if nested:  # np. herb i flaga w osobnej tabelce
            for inner in nested:
                infobox_table_rows(inner, base_url, rows)
            continue
        images = [infobox_images(cell, base_url) for cell in cells]
        if any(images):
            entry = [{"src": found[0], "cap": node_segments(cell, base_url)[0]} for cell, found in zip(cells, images) if found]
            if index < len(trs):  # podpisy w następnym wierszu („Herb”, „Flaga”)
                below = trs[index].find_all(["th", "td"], recursive=False)
                if (len(below) == len(cells) and not any(infobox_images(c, base_url) for c in below)
                        and all(len(node_text(c)) <= 60 for c in below)):
                    captions = [node_segments(c, base_url)[0] for c, found in zip(below, images) if found]
                    for item, caption in zip(entry, captions):
                        item["cap"] = item["cap"] or caption
                    index += 1
            for item in entry:
                item["cap"] = infobox_value(item["cap"])
            rows.append({"img": entry})
            continue
        if len(cells) >= 2 and (cells[0].name == "th" or not has_headers):
            labels = [visible(part) for part in cell_parts(cells[0], base_url) if visible(part)]
            values = [part for part in cell_parts(cells[1], base_url) if visible(part)]
            if not labels or not values:
                continue
            if len(labels) > 1 and len(values) == len(labels) - 1:
                rows.append({"t2": shorten(labels[0], 60)})  # nagłówek grupy, np. „Populacja (30.06.2026)”
                labels = labels[1:]
            if len(labels) == len(values) and len(labels) > 1:
                for label, value in zip(labels, values):
                    rows.append({"l": shorten(label.lstrip("• ").rstrip(":"), 40), "v": infobox_value(value)})
            else:
                rows.append({"l": shorten(" ".join(labels).rstrip(":"), 40), "v": infobox_value(" ".join(values))})
        elif len(cells) == 1:
            text = node_segments(cells[0], base_url)[0]
            if not visible(text):
                continue
            if cells[0].name == "th" and len(visible(text)) <= 80:
                rows.append({"t": visible(text)})
            elif len(visible(text)) <= 300:
                rows.append({"v": text})


LEAD_SKIP = {"nav", "aside", "header", "footer", "figure", "table", "form", "blockquote"}


def readability_anchor(soup, blocks):
    """Akapit w dokumencie, od którego zaczyna się treść wybrana przez readability."""
    first = next((visible(b[1]) for b in blocks if b[0] in ("p", "pl") and len(visible(b[1])) >= 60), None)
    if not first:
        return None
    key = fold(first[:80])
    return next((p for p in soup.find_all("p") if fold(node_text(p)[:80]) == key), None)


def sectioned_root(soup, blocks):
    """Gdy wybrana treść leży w <section>, a jej rodzic ma kilka sekcji (np. Wikipedia: wstęp i działy jako osobne
    sekcje), zwraca ten rodzic – cały artykuł. W przeciwnym razie None."""
    anchor = readability_anchor(soup, blocks)
    root = None
    for ancestor in (anchor.parents if anchor is not None else []):
        if ancestor.name in ("body", "html", "[document]"):
            break
        if ancestor.name == "section" and ancestor.parent is not None:
            if len(ancestor.parent.find_all("section", recursive=False)) >= 2:
                root = ancestor.parent  # najwyższy taki poziom
    return root


def missed_lead(soup, base_url, blocks):
    """Akapity wstępu pominięte przez readability (np. Wikipedia dzieli artykuł na <section>, a readability wybiera
    sekcje z dalszą treścią). Zwraca bloki akapitów stojących przed wybraną treścią w tym samym obszarze strony
    (wspólny „dziadek” pierwszego wybranego akapitu), z pominięciem menu, ramek, tabel i bloków „czytaj też”."""
    first = next((visible(b[1]) for b in blocks if b[0] in ("p", "pl") and len(visible(b[1])) >= 60), None)
    if not first:
        return []
    key = fold(first[:80])
    anchor = next((p for p in soup.find_all("p") if fold(node_text(p)[:80]) == key), None)
    if anchor is None:
        return []
    shown = {fold(visible(b[1])[:80]) for b in blocks if b[0] in ("p", "pl")}
    container, lead = anchor.parent, []
    for _ in range(4):  # w górę (sekcje bywają zagnieżdżone), aż obszar ma akapity przed wybraną treścią
        container = container.parent if container is not None else None
        if container is None or container.name in ("body", "html", "[document]"):
            return []
        lead = lead_paragraphs(container, anchor, shown, base_url)
        if lead:
            return lead[:12]
    return []


def lead_paragraphs(container, anchor, shown, base_url):
    lead = []
    for paragraph in container.find_all("p"):
        if paragraph is anchor:
            break
        skip = False
        for ancestor in paragraph.parents:
            if ancestor is container:
                break
            hint = " ".join(ancestor.get("class") or []) + " " + (ancestor.get("id") or "")
            if ancestor.name in LEAD_SKIP or (hint.strip() and JUNK_HINT.search(hint)):
                skip = True
                break
        text = node_text(paragraph)
        if skip or len(text) < 60 or fold(text[:80]) in shown:
            continue
        segments, count = node_segments(paragraph, base_url)
        lead.append(("pl", segments, None) if count else ("p", text, None))
    return lead


META_LABEL = re.compile(r"^\s*([^\W\d_][\w .'&/-]{0,24}?)\s*:\s*$")
META_SKIP = {"nav", "footer", "header", "aside", "form", "table"}
META_ALWAYS_SKIP = {"nav", "footer", "table"}  # tych elementów nie traktujemy jak ramki z treścią
LABEL_PART = re.compile(r"[^\W\d_][\w .'&/-]{0,24}:")
LABEL_LEAD = re.compile(r"[^\W\d_][\w .'&/-]{0,24}:\s+\S")  # „Rok: 2000” zapisane w jednym kawałku tekstu
META_NOT_DATA = re.compile(r"also|like|related|recommend|more|share|follow|polecan|podobn|zobacz|więcej|udostępnij|czytaj", re.I)


def big_wrapper(tag, soup):
    """Czy element (aside, header, form) obejmuje dużą część strony – wtedy to ramka z główną treścią, a nie panel boczny."""
    body = soup.body or soup
    return len(tag.get_text()) > WRAPPER_SHARE * max(len(body.get_text()), 1)


def meta_rows(soup, base_url):
    """Wiersze danych typu „Autor : Jan Kowalski”, „Tagi : a, b, c” (etykieta z dwukropkiem i linki obok) – jak karta
    z informacjami na oryginalnej stronie. Zwraca wiersze w formacie tabeli informacyjnej i adresy użytych linków."""
    rows, used, seen = [], set(), set()
    for label_text in soup.find_all(string=META_LABEL):
        label_tag = label_text.parent
        if label_tag is None or label_tag.name in ("script", "style", "a", "option", "title"):
            continue
        skipped = False
        for ancestor in [label_tag] + list(label_tag.parents):
            if ancestor.name in META_ALWAYS_SKIP or (ancestor.name in META_SKIP and not big_wrapper(ancestor, soup)):
                skipped = True  # nagłówek i stopka strony, menu, małe panele boczne
                break
        if skipped:
            continue
        row = label_tag
        for _ in range(3):  # w górę do pierwszego poziomu, na którym obok etykiety jest wartość (link albo tekst)
            if row.find("a", href=True) is not None or squash(node_text(row).replace(label_text.strip(), "", 1)):
                break
            if row.parent is None:
                break
            row = row.parent
        if id(row) in seen or len(row.find_all(string=META_LABEL)) > 1 or len(node_text(row)) > 400:
            continue  # cały kontener wielu wierszy albo zwykły tekst
        seen.add(id(row))
        label = META_LABEL.match(label_text).group(1).strip()
        if META_NOT_DATA.search(label):
            continue  # „Zobacz też:”, „You might also like:” – to nie dane tej strony
        links = []
        for link in row.find_all("a", href=True):
            href, text = urljoin(base_url, link["href"].strip()), node_text(link)
            if text and urlparse(href).scheme in ("http", "https") and len(links) < 30:
                links.append(f"\x01{href}\x02{text}\x03")
                used.add(href)
        if links:
            rows.append({"l": label, "v": ", ".join(links)})
        else:
            value = squash(node_text(row).replace(label_text.strip(), "", 1))
            if 1 <= len(value) <= 60:
                rows.append({"l": label, "v": value})
    return (rows, used) if len(rows) >= 2 else ([], set())  # pojedynczy „X:” to zwykle nie karta danych


def breadcrumbs(soup, base_url):
    """Ścieżka nawigacji („Strona główna / Kategoria / …”) – widoczna na stronie (element breadcrumb), a gdy jej brak,
    z JSON-LD BreadcrumbList. Bez ostatniego elementu, gdy to bieżąca strona (tytuł stoi pod spodem)."""
    crumbs = []
    for tag in soup.find_all(True):
        hint = " ".join(tag.get("class") or []) + " " + (tag.get("id") or "") + " " + (tag.get("aria-label") or "")
        if re.search(r"breadcrumb|okruszk", hint, re.I) and tag.name not in ("body", "html", "main"):
            links = tag.find_all("a", href=True)
            if not 1 <= len(links) <= 8 or len(tag.get_text()) > 300:
                continue  # to nie ścieżka, tylko większy obszar z taką klasą (np. „has-breadcrumbs” na ramce strony)
            crumbs = [(shorten(node_text(a), 40), urljoin(base_url, a["href"])) for a in links if node_text(a)]
            if crumbs:
                tag.decompose()  # ścieżkę pokazujemy nad tytułem – nie powtarzamy jej w treści
                break
    if not crumbs:
        crumbs = jsonld_breadcrumbs(soup, base_url)
    page = base_url.split("#")[0].rstrip("/")
    while crumbs and (crumbs[-1][1] is None or crumbs[-1][1].split("#")[0].rstrip("/") == page):
        crumbs.pop()
    return crumbs[:6] if crumbs else []


def jsonld_breadcrumbs(soup, base_url):
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
                if "BreadcrumbList" in str(item.get("@type", "")) and isinstance(item.get("itemListElement"), list):
                    crumbs = []
                    for entry in sorted((e for e in item["itemListElement"] if isinstance(e, dict)),
                                        key=lambda e: e.get("position") or 0):
                        target = entry.get("item")
                        name = entry.get("name") or (target.get("name") if isinstance(target, dict) else None)
                        link = (target.get("@id") or target.get("url")) if isinstance(target, dict) else target
                        if isinstance(name, str) and squash(name):
                            crumbs.append((shorten(squash(name), 40), urljoin(base_url, link) if isinstance(link, str) else None))
                    if len(crumbs) >= 2:
                        return crumbs
                stack.extend(v for v in item.values() if isinstance(v, (list, dict)))
    return []


def site_name(soup):
    for attrs in ({"property": "og:site_name"}, {"name": "application-name"}, {"name": "apple-mobile-web-app-title"}):
        tag = soup.find("meta", attrs=attrs)
        if tag is not None and squash(tag.get("content") or ""):
            return shorten(squash(tag["content"]), 40)
    return None


def extract_article(html, url, videos=None, posters=None, info=None):
    """Zwraca (tytuł, bloki), gdzie blok to ("h" | "p", tekst, adres_linku_lub_None).
    Gdy podano listę `videos`, trafiają do niej adresy filmów ze strony."""
    html = CONTROL_CHARS.sub("", html)
    soup = BeautifulSoup(html, "lxml")
    title = node_text(soup.title) or host_of(url)
    gallery = gallery_images(soup, url)  # przed czyszczeniem – readability wycina galerie
    embedded = json_listing(soup, url)
    if videos is not None:
        videos.extend(find_videos(soup, url, posters=posters, raw=html))  # przed czyszczeniem – readability usuwa <video>
        if info is not None:
            info["audios"] = [a for a in find_audio(soup, url, raw=html) if a not in videos]
        lead = lead_image(soup, url)
        if posters is not None and lead:
            posters[""] = lead[0]  # zdjęcie strony – zapasowa miniatura filmu
    # readability usuwa z obrazków width/height – ikonki rozpoznajemy po wymiarach z oryginalnej strony
    small_images = {image_source(img, url, check_size=False) for img in soup.find_all("img") if is_small_image(img)}
    heading = node_text(soup.find("h1"))
    if info is not None:
        info["crumbs"], info["site_name"] = breadcrumbs(soup, url), site_name(soup)
    meta, meta_links = meta_rows(soup, url)
    infobox = clean_document(soup, url)
    blocks = []
    if Document is not None:
        try:
            doc = Document(str(soup), url=url)
            title = squash(doc.short_title()) or title
            blocks = collect_blocks(
                BeautifulSoup(doc.summary(html_partial=True), "lxml"), url, with_images=True, skip_images=small_images,
                inline_links=True,
            )
            sections = sectioned_root(soup, blocks)
            if sections is not None:  # artykuł podzielony na <section>: cały, a nie jedna sekcja wybrana przez readability
                blocks = collect_blocks(sections, url, with_images=True, skip_images=small_images, inline_links=True)
                while blocks and blocks[-1][0] == "h":
                    blocks.pop()  # puste nagłówki na końcu (np. „Przypisy” po usunięciu listy przypisów)
            else:
                blocks = missed_lead(soup, url, blocks) + blocks
        except Exception as err:
            log.info("readability nie poradził sobie z %s: %s", url, str(err)[:120])
            blocks = []
    # Gdy readability znalazła mało tekstu, to zwykle strona z listą artykułów (np. główna serwisu): readability wycina
    # bloki gęste od linków, czyli właśnie tytuły. Wtedy bierzemy całą treść strony (bez menu i stopki) z tytułami-linkami.
    # Artykuły i Wikipedia mają w readability tysiące znaków – zostają przy niej (bez list „czytaj też”).
    # Strony z listą dostają małe miniatury (THUMB_MAX_SIZE), żeby dziesiątki obrazków nie przeciążyły telefonu.
    readability_chars = sum(len(visible(b[1])) for b in blocks if b[0] != "img")
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
    # Tytuł jak na stronie: nagłówek <h1> zamiast <title> z dopiskiem serwisu („Polska – Wikipedia, wolna encyklopedia”)
    if heading and len(heading) <= 200 and fold(heading) in fold(node_text(soup.title) or title):
        title = heading
    # tytuł pokazujemy osobno – bez powtórzenia w treści (także gdy stoi pod zdjęciem głównym)
    for index, block in enumerate(blocks[:3]):
        if block[0] == "h" and fold(block[1]) == fold(title):
            blocks = blocks[:index] + blocks[index + 1:]
            break
    if meta and not infobox and not front_page:  # karta danych („Autor: …”, „Tagi: …”) pod zdjęciem głównym
        row_texts = {fold(re.sub(r"\s*:\s*", ": ", f"{r['l']}: {visible(r['v'])}")) for r in meta}
        blocks = [b for b in blocks if not (b[0] in ("p", "h") and b[2] in meta_links)
                  and not (b[0] in ("p", "pl") and fold(re.sub(r"\s*:\s*", ": ", visible(b[1]))) in row_texts)]
        position = next((i + 1 for i, b in enumerate(blocks[:6]) if b[0] in ("img", "thumb")), 0)
        if position and blocks[position - 1][0] == "thumb":
            blocks[position - 1] = ("img",) + tuple(blocks[position - 1][1:])  # zdjęcie główne nad kartą – pełne
        blocks.insert(position, ("ib", json.dumps(meta, ensure_ascii=False), None))
    if infobox:  # tabela informacyjna po pierwszym akapicie, jak w mobilnej Wikipedii (także w krótkich hasłach)
        position = next((i + 1 for i, b in enumerate(blocks) if b[0] in ("p", "pl")), 0)
        blocks.insert(position, ("ib", json.dumps(infobox, ensure_ascii=False), None))
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


def infobox_weight(text):
    """Tabela informacyjna na stronie czytnika: tyle co jej tekst, plus zdjęcia (zapis JSON ma też adresy obrazków)."""
    try:
        rows = json.loads(text)
    except ValueError:
        return len(text)
    weight = 0
    for row in rows:
        weight += sum(IMAGE_WEIGHT // 2 for _ in row.get("img", []))
        weight += len(visible(" ".join(str(row.get(k, "")) for k in ("t", "t2", "l", "v")))) + 10
    return weight


def paginate(blocks, budget):
    """Rozkłada bloki na strony po ~budget znaków; nagłówek nie zostaje sam na końcu strony."""
    pages, size = [[]], 0
    weights = {"img": IMAGE_WEIGHT, "thumb": THUMB_WEIGHT, "gi": GRID_WEIGHT}
    is_img = [b[0] == "img" for b in blocks]
    blocks = [("gi",) + tuple(b[1:]) if is_img[i] and ((i and is_img[i - 1]) or (i + 1 < len(blocks) and is_img[i + 1])) else b
              for i, b in enumerate(blocks)]  # obrazki stojące po kilka z rzędu to galeria
    weight = lambda block: weights.get(block[0], infobox_weight(block[1]) if block[0] == "ib" else len(visible(block[1])))
    for kind, text, href in blocks:
        is_image = kind in weights
        if kind == "pl" and len(visible(text)) > budget:
            kind, text = "p", visible(text)  # bardzo długi akapit dzielimy – bez linków w tekście
        pieces = [text] if is_image or kind in ("ib", "pl") else split_long(text, budget)
        for number, piece in enumerate(pieces):
            block = (kind, piece, href if number == 0 or is_image else None)
            if size and size + weight(block) > budget and kind != "ib":  # tabela zostaje przy wstępie
                carry = [pages[-1].pop()] if pages[-1] and pages[-1][-1][0] == "h" else []
                pages.append(carry)
                size = sum(weight(b) for b in carry)
            pages[-1].append(block)
            size += weight(block)
    return [page for page in pages if page]


_inflight = {}
_inflight_lock = threading.Lock()


def get_article(url):
    """Strona w czytniku. Gdy ta sama strona jest właśnie wczytywana (np. z wyprzedzeniem po wyszukiwaniu),
    czekamy na wynik zamiast pobierać ją drugi raz."""
    cached = article_cache.get(url)
    if cached is not None:
        return cached
    with _inflight_lock:
        event = _inflight.get(url)
        owner = event is None
        if owner:
            event = _inflight[url] = threading.Event()
    if not owner:
        event.wait(timeout=30)
        cached = article_cache.get(url)
        if cached is not None:
            return cached
    try:
        return load_article(url)
    finally:
        if owner:
            with _inflight_lock:
                _inflight.pop(url, None)
            event.set()


# ---------- Strony działające tylko z JavaScriptem: Cloudflare Browser Rendering ----------
# Gdy zwykłe pobranie da prawie pusty szkielet aplikacji JavaScript, prosimy Cloudflare o otwarcie strony w prawdziwej
# przeglądarce i bierzemy gotowy HTML. Darmowy plan: 10 min pracy przeglądarki dziennie, 1 zapytanie na 10 s.
# Klucze: zmienne środowiskowe CF_ACCOUNT_ID i CF_API_TOKEN (token z uprawnieniem Browser Rendering – Edit).
CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "").strip().strip("\"' ")
CF_API_TOKEN = os.environ.get("CF_API_TOKEN", "").strip().strip("\"' ")
CF_PATHS = ("browser-rendering", "browser-run")  # nazwa usługi zmieniła się – próbujemy obu
CF_GAP = 10.5  # s między zapytaniami (limit darmowego planu)
CF_WAIT = 8.0  # najwyżej tyle czytnik czeka na wolne miejsce w kolejce
RENDER_MIN_CHARS = 500  # mniej tekstu niż tyle (a strona wygląda na aplikację JS) = renderujemy
SPA_MARKERS = re.compile(r'__NEXT_DATA__|__NUXT__|id="(?:root|app|__next|__nuxt|main-app)"|data-reactroot|ng-version|'
                         r"<noscript>[^<]{0,200}(?:JavaScript|javascript)", re.I)
render_cache = DiskCache("wyrenderowane", ttl=3600, max_files=200)
_render_lock = threading.Lock()
_render_local = threading.local()  # .background = True w wątku wczytywania z wyprzedzeniem
CF_STATE = os.path.join(CACHE_DIR, "cloudflare.json")


def cf_state(update=None):
    """Stan wspólny dla procesów serwera: last (czas ostatniego zapytania), down_until, reason."""
    try:
        with open(CF_STATE, encoding="utf-8") as handle:
            state = json.load(handle)
    except (OSError, ValueError):
        state = {}
    if update:
        state.update(update)
        try:
            os.makedirs(CACHE_DIR, exist_ok=True)
            tmp = f"{CF_STATE}.{uuid.uuid4().hex}"
            with open(tmp, "w", encoding="utf-8") as handle:
                json.dump(state, handle)
            os.replace(tmp, CF_STATE)
        except OSError:
            pass
    return state


def needs_render(html, blocks):
    """Czy strona to szkielet aplikacji JavaScript: prawie bez tekstu, a ze znakami aplikacji (albo bez treści w ogóle)."""
    if not CF_ACCOUNT_ID or not CF_API_TOKEN:
        return False
    if not blocks:
        return True
    chars = sum(len(visible(b[1])) for b in blocks if b[0] in ("h", "p", "pl"))
    return chars < RENDER_MIN_CHARS and (bool(SPA_MARKERS.search(html)) or html.count("<script") >= 8)


def cf_error(resp):
    """Krótki opis błędu z odpowiedzi Cloudflare (kod i komunikat)."""
    try:
        errors = resp.json().get("errors") or []
    except ValueError:
        return resp.text[:150]
    return "; ".join(f"{e.get('code')} {e.get('message')}" for e in errors if isinstance(e, dict))[:200] or resp.text[:150]


def cf_content(body):
    """POST /content – obie nazwy usługi (stara i nowa). Odpowiedź z pierwszej ścieżki, która nie jest 404/401/403,
    a gdy obie odmówią – ostatnią odmowę."""
    headers = {"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "application/json"}
    resp = None
    for path in CF_PATHS:
        try:
            resp = requests.post(f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/{path}/content",
                                 json=body, headers=headers, timeout=(6, 25))
        except requests.exceptions.RequestException as err:
            log.warning("cloudflare: %s", err)
            return None
        if resp.status_code not in (401, 403, 404):
            return resp
    return resp


def render_page(url):
    """Gotowy HTML strony po wykonaniu JavaScriptu (Cloudflare) albo None, gdy się nie da (limit, błąd, brak kluczy)."""
    cached = render_cache.get(url)
    if cached is not None:
        return cached or None
    background = getattr(_render_local, "background", False)
    if not _render_lock.acquire(timeout=0 if background else CF_WAIT):
        return None
    try:
        state = cf_state()
        now = time.time()
        if now < state.get("down_until", 0):
            return None
        pause = state.get("last", 0) + CF_GAP - now
        if pause > (0 if background else CF_WAIT):
            return None
        if pause > 0:
            time.sleep(pause)
        cf_state({"last": time.time()})
        body = {"url": url, "bestAttempt": True, "gotoOptions": {"waitUntil": "networkidle2", "timeout": 15000},
                "rejectResourceTypes": ["image", "media", "font", "stylesheet"]}
        resp = cf_content(body)
        if resp is None:
            return None
        if resp.status_code == 429:
            if "limit exceeded for today" in resp.text.lower() or "time limit" in resp.text.lower():
                tomorrow = (int(time.time() // 86400) + 1) * 86400  # limit dzienny wraca o północy UTC
                cf_state({"down_until": tomorrow, "reason": "dzienny limit wyczerpany"})
            log.warning("cloudflare 429: %s", resp.text[:200])
            return None
        if resp.status_code in (401, 403):
            cf_state({"down_until": time.time() + 600, "reason": f"klucz odrzucony ({resp.status_code}): {cf_error(resp)}"})
            log.warning("cloudflare odrzucił klucz: %s", resp.text[:300])
            return None
        try:
            data = resp.json()
        except ValueError:
            data = {}
        html = data.get("result") if data.get("success") else None
        if not isinstance(html, str):
            log.warning("cloudflare %s: %s", resp.status_code, resp.text[:200])
            render_cache.set(url, "")  # ta strona się nie renderuje – nie próbujemy znowu przez godzinę
            return None
        used = resp.headers.get("X-Browser-Ms-Used")
        log.info("cloudflare: %s (%s ms przeglądarki)", url, used or "?")
        cf_state({"reason": "", "used_ms": int(used) if (used or "").isdigit() else None})
        render_cache.set(url, html)
        return html
    finally:
        _render_lock.release()


def load_article(url):
    started = time.monotonic()
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
        # sam film albo nagranie, nie strona – czytnik przekieruje do /film
        raise VideoLink(final_url, audio=content_type.startswith("audio/") or is_audio_url(final_url))
    if content_type and not (content_type.startswith("text/") or "html" in content_type or "xml" in content_type):
        resp.close()
        raise FetchError("To nie jest strona z tekstem (np. PDF albo obrazek). Otwórz [Oryginał].", 415)
    text = decode_html(read_body(resp), resp)
    fetched = time.monotonic()
    if CHALLENGE_TITLE.search(text[:5000]) and len(text) < 60_000:
        log.warning("strona pokazała sprawdzanie przeglądarki: %s", final_url)
        raise FetchError(BLOCKED_MESSAGE, 403, blocked=True)
    videos, posters, info = [], {}, {}
    if content_type == "text/plain":
        title = host_of(final_url)
        blocks = [("p", squash(part), None) for part in re.split(r"\n\s*\n", text) if squash(part)]
    else:
        title, blocks = extract_article(text, final_url, videos, posters, info)
    rendered = False
    if content_type != "text/plain" and needs_render(text, blocks):
        html = render_page(final_url)
        if html:
            r_videos, r_posters, r_info = [], {}, {}
            r_title, r_blocks = extract_article(html, final_url, r_videos, r_posters, r_info)
            text_len = lambda bl: sum(len(visible(b[1])) for b in bl if b[0] in ("h", "p", "pl"))
            if text_len(r_blocks) > text_len(blocks):
                title, blocks, videos, posters, info, text, rendered = r_title or title, r_blocks, r_videos, r_posters, r_info, html, True
    if not blocks and (videos or info.get("audios")):
        blocks = [("p", "Na tej stronie jest film albo nagranie – wybierz je wyżej.", None)]
    if not blocks:
        raise FetchError("Nie udało się wydobyć tekstu z tej strony. Otwórz [Oryginał].", 422)
    truncated, total, kept = False, 0, []
    for block in blocks:
        total += len(visible(block[1])) if block[0] not in ("img", "thumb") else 0
        if total > ARTICLE_MAX_CHARS:
            truncated = True
            break
        kept.append(block)
    if truncated:
        kept.append(("p", "[Artykuł skrócony – całość w oryginale.]", None))
    extracted = time.monotonic()
    try:
        theme = None
        if content_type != "text/plain":
            theme = theme_cache.get(urlparse(final_url).hostname or "")
            if theme is None:
                theme = site_theme(text, final_url, fetch=False)
                if theme is None or theme.get("partial"):  # pełne barwy (z plików CSS) w tle – od następnej strony serwisu
                    threading.Thread(target=complete_theme, args=(text, final_url), daemon=True).start()
    except Exception:  # wygląd to dodatek – błąd nie może zablokować czytania
        log.exception("motyw strony: %s", final_url)
        theme = None
    done = time.monotonic()
    timing = {"pobranie": fetched - started, "tresc": extracted - fetched, "wyglad": done - extracted}
    log.info("czytnik %s: %s", final_url, ", ".join(f"{k} {v:.1f}s" for k, v in timing.items()))
    article = {"title": title, "url": final_url, "pages": paginate(kept, ARTICLE_PAGE_CHARS), "videos": videos, "timing": timing,
               "posters": posters, "theme": theme, "rendered": rendered,
               "crumbs": info.get("crumbs") or [], "site_name": info.get("site_name"), "audios": info.get("audios") or []}
    article_cache.set(url, article)
    return article


# ---------- Obrazki dopasowane do telefonu ----------
def shrink_image(raw, max_width=IMAGE_MAX_WIDTH, max_height=IMAGE_MAX_HEIGHT, quality=None, background=(255, 255, 255),
                 min_size=IMAGE_MIN_SIZE):
    """Zmniejsza obrazek do ekranu telefonu i zapisuje jako lekki JPEG (bez przezroczystości i metadanych).
    Zwraca None dla ikonek/pikseli śledzących i plików, których nie da się odczytać."""
    try:
        with Image.open(io.BytesIO(raw)) as source:
            if source.width < min_size or source.height < min_size:
                return None
            source.draft("RGB", (max_width * 2, max_height * 2))  # JPEG: dekodowanie od razu w mniejszej skali
            image = ImageOps.exif_transpose(source)  # zdjęcia z telefonów bywają obrócone w metadanych
            if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
                rgba = image.convert("RGBA")
                image = Image.new("RGB", rgba.size, background)
                image.paste(rgba, mask=rgba.getchannel("A"))  # przezroczystość na tle (zwykle białym)
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
    return request.cookies.get("obrazki") != "0" and not saving_enabled()


def saving_enabled():
    """Oszczędzanie danych: bez obrazków, miniatur i ikon (jeden przełącznik)."""
    return request.cookies.get("oszcz") == "1"


# Ustawienia zapamiętane w telefonie (ciasteczka na rok): klucz -> dozwolone wartości.
SETTINGS = {"obrazki": {"0", "1"}, "linki": {"0", "1"}, "tekst": {"s", "m", "l", "xl"}, "oszcz": {"0", "1"},
            "miasto": None}
TEXT_SIZES = {"s": 12, "m": 14, "l": 17, "xl": 20}  # px; 14 to wielkość domyślna
DATA_COOKIE = "dane"


def text_css():
    """Wielkość tekstu wybrana w ustawieniach (nagłówki i drobny tekst skalowane razem z nią)."""
    size = TEXT_SIZES.get(request.cookies.get("tekst") or "m", 14)
    if size == 14:
        return ""
    return (f"body{{font-size:{size}px}}h1{{font-size:{size + 3}px}}h2{{font-size:{size + 1}px}}"
            f".m,.h,.f,.bc,.bar,.o{{font-size:{size - 2}px}}.ib{{font-size:{size - 1}px}}.pi{{font-size:{size + 1}px}}"
            f".logo{{font-size:{size + 20}px}}")


def data_used():
    """Dane wysłane do telefonu przez Szukajkę w tym miesiącu (w bajtach) – z licznika w ciasteczku."""
    month, _, value = (request.cookies.get(DATA_COOKIE) or "").partition(":")
    return int(value) if month == time.strftime("%Y%m") and value.isdigit() else 0


def safe_next(target):
    """Powrót tylko na adres w tej aplikacji."""
    target = target or "/"
    return target if target.startswith("/") and not target.startswith("//") else "/"


def links_enabled():
    return request.cookies.get("linki") != "0"


def inline_links(text, q, rp):
    """Akapit z linkami w tekście jako HTML: linki prowadzą przez czytnik, reszta tekstu jest escapowana."""
    out, last = [], 0
    for match in LINK_MARK.finditer(text):
        out.append(escape(text[last:match.start()]))
        href = url_for("read", url=match.group(1), q=q or None, rp=rp)
        out.append(Markup('<a href="%s">%s</a>') % (href, match.group(2)))
        last = match.end()
    out.append(escape(text[last:]))
    return Markup("").join(out)


def infobox_rows(text):
    try:
        return json.loads(text)
    except ValueError:
        return []


# ---------- Wygląd strony źródłowej ----------
# Czytnik przejmuje barwy oryginalnej strony: kolor marki (pasek, linki, przyciski), jasne albo ciemne tło i ikonę
# serwisu. Barwy pochodzą z <meta name="theme-color">, z CSS strony (zmienne --primary/--brand…, kolor linków, tło
# body, najczęstszy wyrazisty kolor) i z oznaczeń trybu ciemnego. Kontrast pilnujemy, żeby tekst był czytelny.
CSS_COLOR = re.compile(r"#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*[\d.]+\s*)?\)", re.I)
CSS_BRAND_VAR = re.compile(r"--([\w-]*(?:primary|brand|accent|main|theme|link)[\w-]*)\s*:\s*([^;}]+)", re.I)
CSS_BODY_RULE = re.compile(r"(?:^|(?<=[};]))\s*([^{};@]*\b(?:html|body)\b[^{};@]*)\{([^}]*)\}", re.I | re.M)
CSS_VAR_DEF = re.compile(r"(--[\w-]+)\s*:\s*([^;}]+)")
CSS_LINK = re.compile(r"(?:^|[}\s,])a(?::link)?\s*\{([^}]*)\}", re.I)
DARK_HINT = re.compile(r"<(?:html|body)[^>]*(?:class|data-theme|data-bs-theme|data-color-mode)=[\"'][^\"']*\bdark", re.I)
THEME_CSS_BYTES = 400_000
THEME_STYLESHEETS = 4
theme_cache = DiskCache("motywy", ttl=6 * 3600, max_files=300)  # motyw serwisu (wg hosta) – także dla stron filmów
stylesheet_cache = DiskCache("arkusze", ttl=24 * 3600, max_files=200)


def parse_color(value):
    """(r, g, b) z #abc, #aabbcc albo rgb()/rgba() (prawie przezroczyste pomijamy) – albo None."""
    if not value:
        return None
    match = CSS_COLOR.search(value)
    if not match:
        return None
    text = match.group().lower()
    if text.startswith("#"):
        digits = text[1:]
        if len(digits) == 3:
            digits = "".join(c * 2 for c in digits)
        return tuple(int(digits[i:i + 2], 16) for i in (0, 2, 4))
    parts = [p.strip() for p in text[text.index("(") + 1:-1].split(",")]
    if len(parts) == 4 and float(parts[3] or 1) < 0.5:
        return None
    rgb = tuple(min(255, int(p)) for p in parts[:3])
    return rgb


def luminance(rgb):
    def channel(c):
        c /= 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (channel(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def saturation(rgb):
    return (max(rgb) - min(rgb)) / 255


def mix(a, b, amount):
    return tuple(round(x + (y - x) * amount) for x, y in zip(a, b))


def hex_color(rgb):
    return "#%02x%02x%02x" % rgb


def readable(color, background, minimum=4.5):
    """Przyciemnia albo rozjaśnia kolor, aż będzie czytelny na tle."""
    target = (255, 255, 255) if luminance(background) < 0.4 else (0, 0, 0)
    for step in range(11):
        candidate = mix(color, target, step / 10)
        if contrast(candidate, background) >= minimum:
            return candidate
    return target


def css_value_color(value, variables):
    """Kolor z wartości CSS, także przez zmienne var(--nazwa) (do 3 poziomów)."""
    for _ in range(3):
        match = re.search(r"var\(\s*(--[\w-]+)", value or "")
        if not match:
            break
        value = variables.get(match.group(1), "")
    return parse_color(value)


def body_background(css, html):
    """Tło strony: reguły dla html/body, których klasy pasują do znaczników tej strony (np. body.v7, html.dark body)."""
    classes = {}
    for tag in ("html", "body"):
        match = re.search(rf"<{tag}\b[^>]*\bclass=[\"']([^\"']*)", html[:300_000], re.I)
        classes[tag] = set(match.group(1).split()) if match else set()
    variables = {}
    for name, value in CSS_VAR_DEF.findall(css):
        variables.setdefault(name, value)  # pierwsza definicja – zwykle :root
    found = None
    for selectors, decl in CSS_BODY_RULE.findall(css):
        match = re.search(r"background(?:-color)?\s*:\s*([^;}]+)", decl)
        if not match:
            continue
        for selector in selectors.split(","):
            parts = re.findall(r"\b(html|body)((?:\.[\w-]+)*)(?=[\s>]|$)", selector.strip())
            last = selector.strip().split()[-1] if selector.strip() else ""
            if not parts or not re.match(r"^(html|body)\b", last):
                continue  # reguła dotyczy elementu wewnątrz body, nie samego tła
            if all(set(filter(None, cls.split("."))) <= classes[tag] for tag, cls in parts):
                color = css_value_color(match.group(1), variables)
                if color:
                    found = color  # późniejsza reguła wygrywa, jak w przeglądarce
    return found


def fetch_stylesheet(url, site):
    cached = stylesheet_cache.get(url)
    if cached is not None:
        return cached
    css = ""
    try:
        _, resp = http_request(url, extra_headers={"Accept": "text/css,*/*;q=0.1", "Referer": site + "/"})
        if resp.status_code < 400:
            css = read_body(resp, limit=THEME_CSS_BYTES).decode("utf-8", "replace")
        else:
            resp.close()
    except FetchError:
        pass
    stylesheet_cache.set(url, css)
    return css


def site_theme(html, base_url, fetch=True):
    """Motyw strony: kolory (hex) dla paska, linków, tła, tekstu, przycisków i ikona serwisu – albo None.
    fetch=False: bez pobierania arkuszy CSS (tylko te już zapamiętane) – szybki motyw na pierwszą stronę serwisu;
    wtedy w motywie jest "partial": True, a pełny warto policzyć w tle."""
    parts = urlparse(base_url)
    site = f"{parts.scheme}://{parts.netloc}"
    head = BeautifulSoup(html[:600_000], "lxml", parse_only=SoupStrainer(["meta", "link", "style"]))

    def meta(name):
        tag = head.find("meta", attrs={"name": name}) or head.find("meta", attrs={"property": name})
        return (tag.get("content") or "") if tag is not None else ""

    css = "\n".join(tag.get_text() for tag in head.find_all("style"))
    sheets = [urljoin(base_url, link["href"]) for link in head.find_all("link", href=True)
              if "stylesheet" in [r.lower() for r in (link.get("rel") or [])]][:THEME_STYLESHEETS]
    partial = False
    if sheets and not fetch:
        known = [stylesheet_cache.get(url) for url in sheets]
        partial = any(css_text is None for css_text in known)
        css += "\n" + "\n".join(css_text or "" for css_text in known)
        sheets = []
    if sheets:
        results = [""] * len(sheets)

        def load(index, url):
            results[index] = fetch_stylesheet(url, site)

        threads = [threading.Thread(target=load, args=(i, u), daemon=True) for i, u in enumerate(sheets)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=6)  # wygląd nie może opóźniać czytania
        css += "\n" + "\n".join(results)

    brand = parse_color(meta("theme-color")) or parse_color(meta("msapplication-TileColor"))
    accents = [parse_color(v) for _, v in CSS_BRAND_VAR.findall(css)]
    accents = [c for c in accents if c and saturation(c) >= 0.25]
    link_rule = next((parse_color(m.group(1)) for m in (re.search(r"(?<![-\w])color\s*:\s*([^;}]+)", d) for d in CSS_LINK.findall(css))
                      if m and parse_color(m.group(1))), None)
    counts = collections.Counter(
        c for c in (parse_color(m.group()) for m in CSS_COLOR.finditer(css)) if c and saturation(c) >= 0.35
    )
    common = counts.most_common(1)[0][0] if counts else None
    accent = (accents[0] if accents else None) or (link_rule if link_rule and saturation(link_rule) >= 0.25 else None) or common
    background = body_background(css, html)
    dark = bool(DARK_HINT.search(html[:20_000])) or meta("color-scheme").strip().lower() == "dark"
    if background is None:
        background = (18, 18, 18) if dark else (255, 255, 255)
    if not brand and not accent and background == (255, 255, 255):
        return None  # nic charakterystycznego – zostaje wygląd domyślny
    if brand and (luminance(brand) > 0.85 or contrast(brand, background) < 1.3) and accent:
        brand = accent  # biały/zlewający się z tłem theme-color – pasek w kolorze akcentu
    brand = brand or accent or (0x0b, 0x57, 0xd0)
    accent = accent or (brand if saturation(brand) >= 0.25 else (0x0b, 0x57, 0xd0))
    text = (232, 232, 232) if luminance(background) < 0.25 else (34, 34, 34)
    link = readable(accent, background)
    # biały napis, jeśli jest czytelny (próg jak dla pogrubionego tekstu) – tak wygląda większość pasków serwisów
    bar_text = (255, 255, 255) if contrast((255, 255, 255), brand) >= 3 else (0, 0, 0)
    icon = None
    for rel in ("apple-touch-icon", "apple-touch-icon-precomposed", "icon", "shortcut icon"):
        for link_tag in head.find_all("link", href=True):
            rels = " ".join(link_tag.get("rel") or []).lower()
            href = urljoin(base_url, link_tag["href"])
            if rels == rel and not urlparse(href).path.lower().endswith(".svg") and urlparse(href).scheme in ("http", "https"):
                icon = href
                break
        if icon:
            break
    theme = {
        "bar": hex_color(brand), "bar_text": hex_color(bar_text), "link": hex_color(link), "bg": hex_color(background),
        "text": hex_color(text), "muted": hex_color(mix(text, background, 0.4)), "line": hex_color(mix(background, text, 0.15)),
        "button": hex_color(mix(background, link, 0.12)), "button_line": hex_color(mix(background, link, 0.4)),
        "icon": icon or f"{site}/favicon.ico", "site": site,
    }
    if partial:
        theme["partial"] = True
    else:
        theme_cache.set(parts.hostname or "", theme)
    return theme


def theme_css(theme):
    """Mały blok CSS nadpisujący domyślne kolory barwami serwisu (same wartości hex – bezpieczne w <style>)."""
    if not theme:
        return ""
    t = theme
    return (
        f"body{{background:{t['bg']};color:{t['text']}}}a{{color:{t['link']}}}"
        f".bar{{background:{t['bar']};color:{t['bar_text']}}}.bar a{{color:{t['bar_text']}}}"
        f".m,.h,.f{{color:{t['muted']}}}.it,.r{{border-color:{t['line']}}}.f{{border-color:{t['line']}}}"
        f".b,.v{{background:{t['button']};border-color:{t['button_line']};color:{t['link']}}}"
        f".s{{color:{t['text']}}}"
        f".ib{{background:{t['button']};border-color:{t['line']}}}"
        f"input[type=submit]{{background:{t['bar']};color:{t['bar_text']}}}"
    )


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
VIDEO_INPUT_FORMATS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,flv,mpegts,mpeg,ogg,asf,aac,mp3,wav,flac"
VIDEO_FORMATS = {
    "mp4": {"name": "MP4", "mime": "video/mp4", "about": "H.264, do 320×240, ok. 2 MB na minutę"},
    "3gp": {"name": "3GP", "mime": "video/3gpp", "about": "H.263, 176×144, ok. 1,2 MB na minutę – dla starszych odtwarzaczy"},
    "mp3": {"name": "MP3", "mime": "audio/mpeg", "about": "dźwięk 80 kb/s stereo, ok. 0,6 MB na minutę"},
}
VIDEO_CHOICES = ("mp4", "3gp")
AUDIO_CHOICES = ("mp3",)
AUDIO_FILE = re.compile(r"\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|wma)$", re.I)
AUDIO_IN_HTML = re.compile(r"<audio|og:audio|AudioObject|PodcastEpisode|\.(?:mp3|m4a|aac|ogg|oga|opus|flac)\b", re.I)


def is_audio_url(url):
    path = urlparse(url).path
    return bool(AUDIO_FILE.search(path)) and ":" not in unquote(path.rsplit("/", 1)[-1])


def find_audio(soup, base_url, raw=None):
    """Nagrania na stronie (muzyka, podcasty): <audio>/<source>, og:audio, JSON-LD (AudioObject, PodcastEpisode),
    linki do plików dźwiękowych. Najwyżej VIDEOS_PER_ARTICLE."""
    if raw is not None and not AUDIO_IN_HTML.search(raw):
        return []
    found = []

    def add(value, need_ext=False):
        value = (value or "").strip()
        if not value or value.startswith(("blob:", "data:")):
            return
        src = urljoin(base_url, value)
        if urlparse(src).scheme not in ("http", "https") or len(src) > MAX_URL_LENGTH or (need_ext and not is_audio_url(src)):
            return
        if src not in found:
            found.append(src)

    for audio in soup.find_all("audio"):
        add(pick_video_source(audio))
    for name in ("og:audio:secure_url", "og:audio:url", "og:audio"):
        for meta in soup.find_all("meta", attrs={"property": name}) + soup.find_all("meta", attrs={"name": name}):
            add(meta.get("content"))
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
                kind = str(item.get("@type", ""))
                if ("Audio" in kind or "Podcast" in kind) and isinstance(item.get("contentUrl"), str):
                    add(item["contentUrl"])
                stack.extend(v for v in item.values() if isinstance(v, (list, dict)))
    for link in soup.find_all("a", href=True):
        add(link["href"], need_ext=True)
    return found[:VIDEOS_PER_ARTICLE]
VIDEO_ACTIVE = ("download", "convert")


class VideoCancelled(Exception):
    """Zadanie w tle przerwane, bo ktoś zaczął oglądać inny film."""


def part_length(index):
    return VIDEO_FIRST_PARTS[index] if index < len(VIDEO_FIRST_PARTS) else VIDEO_PART_SECONDS


def part_bounds(index):
    """(początek, długość) części filmu w sekundach (części numerowane od 0)."""
    return sum(part_length(i) for i in range(index)), part_length(index)


def part_count(total):
    count, start = 0, 0
    while start < (total or 0) - 1 and count < VIDEO_MAX_PARTS:  # bez ułamka sekundy jako osobnej części
        start += part_length(count)
        count += 1
    return max(count, 1)
_ffmpeg = {}
_video_start_lock = threading.Lock()


class VideoLink(Exception):
    """Pod adresem otwieranym w czytniku jest film, a nie strona."""

    def __init__(self, url, audio=False):
        super().__init__(url)
        self.url = url
        self.audio = audio


def is_video_url(url):
    path = urlparse(url).path
    # „File:Film.webm”, „TimedText:Film.webm” – strony opisu w wiki (MediaWiki), a nie pliki
    return bool(VIDEO_FILE.search(path)) and ":" not in unquote(path.rsplit("/", 1)[-1])


def media_family(url):
    """Ten sam film w różnych jakościach („film.webm.240p.vp9.webm”, „film-720p.mp4”) liczymy jako jeden."""
    name = unquote(urlparse(url).path.rsplit("/", 1)[-1]).lower()
    name = re.sub(r"\.\d{3,4}p(\.[a-z0-9]+)*$", "", name)
    return re.sub(r"[._-]\d{3,4}p(?=\.[a-z0-9]+$)", "", name)


def is_video_response(content_type, url):
    if content_type.startswith(("video/", "audio/")) or "mpegurl" in content_type:
        return True
    return (is_video_url(url) or is_audio_url(url)) and ("html" not in content_type)


def player_key(url):
    """Ten sam odtwarzacz pod różnymi adresami (parametry, wistia.net/.com) liczymy raz."""
    return re.sub(r"[?#].*$", "", url.lower()).replace("wistia.net", "wistia.com").replace("/medias/", "/iframe/").rstrip("/")


def pick_video_source(video):
    """Źródło z <video>: pomija blob:/data: i DASH (.mpd), a z kilku jakości wybiera najmniejszą, która wypełni
    ekran telefonu (wysokość ≥ 216 px wg data-height/height/res/size/label), w przeciwnym razie pierwsze."""
    options = []
    for tag in [video] + video.find_all("source"):
        value = (tag.get("src") or tag.get("data-src") or "").strip()
        kind = (tag.get("type") or "").lower()
        if not value or value.startswith(("blob:", "data:")) or "dash" in kind or urlparse(value).path.lower().endswith(".mpd"):
            continue
        height = 0
        for attr in ("data-height", "height", "res", "size", "data-res", "label", "data-quality"):
            match = re.search(r"(\d{3,4})", str(tag.get(attr) or ""))
            if match:
                height = int(match.group(1))
                break
        if not height:
            match = re.search(r"(\d{3,4})p\b", value)
            height = int(match.group(1)) if match else 0
        options.append((height, value))
    if not options:
        return None
    sized = [o for o in options if o[0]]
    enough = [o for o in sized if o[0] >= 216]
    if enough:
        return min(enough)[1]
    return options[0][1]


def first_image_url(value):
    """thumbnailUrl / image z JSON-LD bywa napisem, listą albo obiektem ImageObject."""
    if isinstance(value, list):
        value = value[0] if value else None
    if isinstance(value, dict):
        value = value.get("url") or value.get("contentUrl")
    return value if isinstance(value, str) else None


VIDEO_IN_HTML = re.compile(r"\.(?:mp4|m4v|webm|m3u8|mov|3gp|mkv|avi|flv|mpe?g)\b|<video|og:video|twitter:player|VideoObject|"
                           r"player\.vimeo|jwplayer|jwplatform|wistia|kaltura|<iframe", re.I)


def find_videos(soup, base_url, deep=False, posters=None, raw=None):
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
    if raw is not None and not VIDEO_IN_HTML.search(raw):
        return []  # w kodzie strony nie ma śladu filmu – pomijamy kosztowne przeglądanie (większość stron)
    has_file = raw is None or re.search(r"\.(?:mp4|m4v|webm|m3u8|mov|3gp)\b", raw, re.I) is not None
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
        if media_family(src).split(":")[-1] in {media_family(d) for d in direct}:
            return  # ten sam film w innej jakości albo strona odtwarzacza z tym samym plikiem („File:Film.webm”)
        if src not in direct and key not in (player_key(p) for p in players):
            target.append(src)
        poster = (poster or "").strip()
        if poster and src not in found_posters and not poster.startswith(("data:", "blob:")):
            found_posters[src] = urljoin(base_url, poster)

    for video in soup.find_all("video"):
        value = pick_video_source(video)
        if value:
            add(value, direct, poster=video.get("poster") or video.get("data-poster"))
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
    for tag in soup.find_all(True) if has_file or (raw is not None and "wistia_async" in raw) else []:
        # atrybuty typu data-video-src="…mp4", data-hls="…m3u8", <param value="…">
        for name, value in tag.attrs.items():
            if (isinstance(value, str) and (name.startswith("data-") or name in ("value", "content")) and "/" in value
                    and VIDEO_HINT.search(value)):  # sama nazwa wariantu (np. „480p.vp9.webm”) to nie adres
                thumb = next((tag.get(a) for a in ("data-poster", "poster", "data-thumbnail", "data-thumb", "data-image")
                              if isinstance(tag.get(a), str)), None)
                add(value, direct, need_ext=True, poster=thumb)
        classes = " ".join(tag.get("class") or [])
        wistia = re.search(r"wistia_async_([a-z0-9]{10})", classes)
        if wistia:
            add(f"https://fast.wistia.net/embed/iframe/{wistia.group(1)}", players)
    for link in soup.find_all("a", href=True) if has_file else []:
        add(link["href"], direct, need_ext=True)
    frame_srcs = list(filter(None, (f.get("src") or f.get("data-src") or f.get("data-lazy-src")
                                    for f in soup.find_all("iframe"))))
    for value in frame_srcs:
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
        page = raw if raw is not None else str(soup)
        partner, entry = (KALTURA_PARTNER.search(page), KALTURA_ENTRY.search(page)) if "kaltura" in page.lower() else (None, None)
        if partner and entry:  # Kaltura (m.in. uczelniane serwisy wideo)
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
    if fmt == "mp3":  # sam dźwięk: MP3 odtworzy każdy telefon, 80 kb/s stereo to ok. 0,6 MB na minutę
        return ["-vn", "-c:a", "libmp3lame", "-b:a", "80k", "-ar", "44100", "-ac", "2", "-f", "mp3"]
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


def active_jobs():
    jobs = []
    for name in os.listdir(VIDEO_DIR):
        if name.endswith(".json"):
            status = read_status(name[:-5])
            if status and status.get("state") in VIDEO_ACTIVE:
                jobs.append((name[:-5], status))
    return jobs


def active_video_jobs():
    return len(active_jobs())


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
    start, length = part_bounds(part)
    if start >= total:
        raise FetchError("Ten film nie ma takiej części.", 404)
    base = "hls-" + hashlib.sha1(f"{url}\n{part}".encode("utf-8")).hexdigest()[:32]
    picked = [(suffix, item) + pick_segments(item, start, start + length) for suffix, item in lists]
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
        return [(cached, part_bounds(part)[0])], None
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
        found = find_videos(BeautifulSoup(CONTROL_CHARS.sub("", html), "lxml"), final_url, deep=True, raw=html)
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
    return [(cached, part_bounds(part)[0])], None


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
    return duration, bool(re.search(r"Stream #\S+.*: Video:", out)), bool(re.search(r"Stream #\S+.*: Audio:", out))


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
        except BaseException:
            proc.kill()  # np. zadanie przerwane – ffmpeg nie może pracować dalej
            proc.wait()
            raise
        finally:
            timer.cancel()
        if code != 0:
            errors.seek(0)
            log.warning("ffmpeg zakończył się kodem %s: %s", code, errors.read()[-600:].decode("utf-8", "replace"))
            if timed_out.is_set():
                raise FetchError("Przekodowanie trwało za długo. Spróbuj krótszego filmu.", 504)
            raise FetchError("Nie udało się przekodować filmu (nieobsługiwany format?).", 415)


# Martwe kafelki: odtwarzacze, z których nie dało się wziąć filmu (chroniony strumień, film tylko przez JavaScript).
# Zapamiętujemy adres, a gdy z jednego serwera odtwarzaczy kolejne adresy też zawodzą (i żaden się nie udał) – cały
# serwer. Takich kafelków czytnik już nie pokazuje.
player_memory = DiskCache("odtwarzacze", ttl=14 * 24 * 3600, max_files=3000)
DEAD_HOST_FAILS = 3


def player_host(url):
    host = (urlparse(url).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def note_player(src, ok):
    """Wynik pierwszej części filmu z adresu src: ok=True – film się udał, False – nic do wzięcia (błąd 415)."""
    key = "u:" + player_key(src)
    if not ok and player_memory.get(key):
        return  # ten adres już jest policzony
    player_memory.set(key, not ok)
    if is_video_url(src) or is_audio_url(src):
        return  # plik podany wprost – nie świadczy o całym serwerze
    fails, oks = player_memory.get("h:" + player_host(src)) or (0, 0)
    player_memory.set("h:" + player_host(src), (fails + (not ok), oks + bool(ok)))


# Strony z filmami: czy film z danej strony udało się obejrzeć. Zapisane w telefonie (ciasteczko – przetrwa restart
# darmowego serwera) i na serwerze. Wyszukiwanie filmów ukrywa strony, na których filmy nie działają.
VIDEO_SITES_COOKIE = "filmy"
VIDEO_SITES_MAX = 80
VIDEO_SITES_BYTES = 1500
VIDEO_QUERY = re.compile(
    r"\b(?:hentai|film\w*|video\w*|wideo\w*|odcin\w*|episode\w*|serial\w*|anime|porn\w*|xxx|sex\w*|seks\w*|"
    r"obejrz\w*|ogl[aą]d\w*|watch|stream\w*|bajk\w*|kresk[oó]wk\w*|teledys\w*|klip\w*)\b", re.I)


def read_video_sites():
    """[(host, działa)] z ciasteczka, najnowsze pierwsze."""
    raw = request.cookies.get(VIDEO_SITES_COOKIE) or ""
    try:
        data = json.loads(zlib.decompress(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))).decode("utf-8"))
    except (ValueError, zlib.error, TypeError):
        return []
    if not isinstance(data, list):
        return []
    return [(h, bool(ok)) for h, ok in data if isinstance(h, str) and len(h) < 100][:VIDEO_SITES_MAX]


def encode_video_sites(items):
    items = items[:VIDEO_SITES_MAX]
    while True:
        raw = base64.urlsafe_b64encode(zlib.compress(json.dumps([[h, int(ok)] for h, ok in items]).encode(), 9)).decode().rstrip("=")
        if len(raw) <= VIDEO_SITES_BYTES or not items:
            return raw
        items = items[:-1]


def site_videos_work(host, sites):
    """True – filmy z tej strony działały, False – nie działały (i żaden się nie udał), None – nie wiadomo.
    Sprawdza też domenę nadrzędną (pl.serwis.com -> serwis.com)."""
    host = (host or "").lower()
    host = host[4:] if host.startswith("www.") else host
    while host.count(".") >= 1:
        if host in sites:
            return sites[host]
        known = player_memory.get("s:" + host)
        if known is not None:
            return known
        host = host.split(".", 1)[1]
    return None


def dead_player(url):
    if player_memory.get("u:" + player_key(url)):
        return True
    if is_video_url(url) or is_audio_url(url):
        return False
    fails, oks = player_memory.get("h:" + player_host(url)) or (0, 0)
    return oks == 0 and fails >= DEAD_HOST_FAILS


def video_job(key, src, referer, fmt, part, auto=False):
    """Zadanie w tle: pobranie źródła, przekodowanie, zapis gotowego pliku. Postęp zapisuje do <key>.json.
    auto=True: następna część przygotowywana z wyprzedzeniem – ustępuje miejsca filmom, które ktoś właśnie wybrał."""
    status = {"state": "download", "fmt": fmt, "part": part, "got": 0, "progress": 0, "auto": auto}
    cancel = video_path(key + ".cancel")

    def report(**changes):
        if os.path.exists(cancel):
            raise VideoCancelled()
        status.update(changes)
        write_status(key, status)

    out_tmp = video_path(f"{key}.work.{fmt}")
    try:
        cleanup_videos()
        exe, _ = ffmpeg_info()
        if not exe:
            raise FetchError("Na serwerze brakuje programu ffmpeg (pakiet imageio-ffmpeg).", 500)
        inputs, total = prepare_source(src, referer, part, report)
        duration, has_video, has_audio = probe_video(exe, inputs[0][0])
        audio_only = fmt in AUDIO_CHOICES
        if audio_only and not (has_audio or len(inputs) > 1):
            raise FetchError("W tym pliku nie ma dźwięku albo jego format nie jest obsługiwany.", 415)
        if not audio_only and not has_video:
            raise FetchError("W tym pliku nie ma obrazu albo jego format nie jest obsługiwany.", 415)
        total = total or duration
        start, part_seconds = part_bounds(part)
        if total and start >= total:
            raise FetchError("Ten film nie ma takiej części.", 404)
        length = min(part_seconds, total - start) if total else part_seconds
        report(state="convert", progress=0, total=total, length=length)
        cmd = [exe, "-hide_banner", "-nostdin", "-y", "-loglevel", "error"]
        for path, offset in inputs:
            cmd += ["-protocol_whitelist", "file", "-format_whitelist", VIDEO_INPUT_FORMATS]
            if offset > 0.05:
                cmd += ["-ss", f"{offset:.2f}"]
            cmd += ["-i", path]
        maps = ["-map", "1:a:0" if len(inputs) > 1 else "0:a:0"] if audio_only else \
            ["-map", "0:v:0", "-map", "1:a:0?" if len(inputs) > 1 else "0:a:0?"]
        cmd += ["-t", str(part_seconds), *maps,
                "-sn", "-dn", "-map_metadata", "-1", "-threads", "2", *encode_args(fmt),
                "-progress", "pipe:1", "-nostats", out_tmp]
        run_ffmpeg(cmd, length, report)
        out = video_path(f"{key}.{fmt}")
        os.replace(out_tmp, out)
        report(state="done", progress=100, size=os.path.getsize(out))
        if part == 0:
            note_player(src, True)
        log.info("film gotowy: %s część %s (%s, %d B)", src, part + 1, fmt, status["size"])
        if not auto and total and part + 1 < part_count(total):  # następna część od razu, w tle
            start_video_job(video_key(src, fmt, part + 1), src, referer, fmt, part + 1, auto=True)
    except VideoCancelled:
        log.info("przerwano przygotowanie w tle: %s część %s", src, part + 1)
        for path in (video_path(key + ".json"),):
            if os.path.exists(path):
                os.remove(path)  # zacznie się od nowa, gdy ktoś poprosi o tę część
    except FetchError as err:
        log.warning("film nieudany: %s – %s", src, err.message)
        dead = err.status == 415  # nie ma tu filmu, który dałoby się wziąć – kafelek jest martwy
        if dead and part == 0:
            note_player(src, False)
        status.update(state="error", message=err.message, blocked=err.blocked, dead=dead)
        write_status(key, status)
    except Exception:
        log.exception("film nieudany: %s", src)
        status.update(state="error", message="Nie udało się przygotować filmu. Spróbuj ponownie albo wybierz inny format.")
        write_status(key, status)
    finally:
        for path in (out_tmp, video_path(key + ".claim"), cancel):
            if os.path.exists(path):
                os.remove(path)


def start_video_job(key, src, referer, fmt, part, auto=False):
    """Uruchamia przygotowanie filmu w tle. False, gdy serwer zajmuje się już VIDEO_JOBS innymi filmami.
    Film wybrany przez użytkownika przerywa zadania „auto” (części przygotowywane z wyprzedzeniem)."""
    os.makedirs(VIDEO_DIR, exist_ok=True)
    with _video_start_lock:
        current = read_status(key)
        if current and current.get("state") in VIDEO_ACTIVE + ("done",):
            return True
        jobs = active_jobs()
        if len(jobs) >= VIDEO_JOBS:
            background = [k for k, st in jobs if st.get("auto")]
            if auto or len(jobs) - len(background) >= VIDEO_JOBS:
                return False
            for other in background:  # ustępują: zatrzymają się w ciągu ok. 2 s
                open(video_path(other + ".cancel"), "w").close()
        if os.path.exists(video_path(key + ".cancel")):
            os.remove(video_path(key + ".cancel"))  # pozostałość po przerwanym wcześniej zadaniu
        claim = video_path(key + ".claim")  # chroni przed startem tego samego zadania w drugim procesie Gunicorna
        try:
            os.close(os.open(claim, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
        except FileExistsError:
            if time.time() - os.path.getmtime(claim) < 30:
                return True
            os.utime(claim)
        write_status(key, {"state": "download", "fmt": fmt, "part": part, "got": 0, "progress": 0, "auto": auto})
    threading.Thread(target=video_job, args=(key, src, referer, fmt, part, auto), daemon=True).start()
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
    found = find_videos(soup, final_url, deep=True, posters=posters, raw=html)
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
    # Presto (Opera Mini na S30+) rozumie border-radius, box-shadow, rgba i box-sizing; starsze przeglądarki pokażą
    # po prostu kanciaste ramki. Na szerokim ekranie treść stoi w kolumnie 680 px, na telefonie zajmuje całą szerokość.
    "html{background:#e8eaed}"
    "body{margin:0 auto;max-width:680px;font:14px/1.5 system-ui,Roboto,Arial,sans-serif;color:#1f1f1f;background:#fff}"
    "a{color:#0b57d0;text-decoration:none}img{border:0}"
    ".bar{background:#0b57d0;color:#fff;padding:5px 6px;font-size:12px;line-height:1.7;box-shadow:0 1px 3px #999}"
    ".bar a{color:#fff;display:inline-block;padding:1px 7px;margin:1px 1px;border-radius:12px;background:rgba(128,128,128,.25)}"
    ".ic{vertical-align:middle;margin:0 3px 0 1px;border-radius:3px}"
    ".w{padding:6px 8px 8px}"
    "h1{font-size:17px;line-height:1.25;margin:8px 0 3px}"
    "h2{font-size:15px;line-height:1.3;margin:16px 0 6px}"
    "p{margin:0 0 10px}"
    ".m{color:#5f6368;font-size:12px;margin:0 0 10px}"
    ".it{border-bottom:1px solid #eee;padding:8px 0;overflow:hidden}"
    ".it img{float:left;width:76px;margin:0 8px 0 0;border-radius:6px}"
    ".it a,.r a.t,.v a,.f a{font-weight:bold}.it a.n{display:block;margin-left:84px}"
    ".ph{margin:6px 0 12px}.ph img{max-width:100%;border-radius:8px}"
    ".gr{margin:6px 0 12px}.gr a{display:inline-block;width:49%;margin:0 0 6px;text-align:center;vertical-align:top}"
    ".gr a:nth-child(even){margin-left:2%}.gr img{max-width:100%;border-radius:6px}"
    ".ib{border:1px solid #dadce0;background:#f8f9fa;padding:8px 10px;margin:6px 0 12px;font-size:13px;line-height:1.4;"
    "border-radius:10px}"
    ".bc{font-size:12px;margin:8px 0 0;color:#5f6368}.ibt{font-weight:bold;text-align:center;margin:2px 0 6px}"
    ".ibi{text-align:center;margin:4px 0 8px}.ib img{max-width:100%;border-radius:6px}"
    ".ib2{display:inline-block;width:48%;vertical-align:top;text-align:center}"
    ".v{margin:8px 0 12px;padding:6px;text-align:center;background:#eef3fd;border:1px solid #d3e0fb;border-radius:12px}"
    ".v img{max-width:100%;margin:0 0 6px;border-radius:8px}.v video,.v audio{width:100%;margin:0 0 6px}"
    ".v video{max-width:480px;background:#000}"
    ".r{border-bottom:1px solid #eee;padding:9px 0}"
    ".h{color:#188038;font-size:12px}.s{color:#4d5156}.o{font-size:12px}"
    ".b{display:block;background:#eef3fd;border:1px solid #d3e0fb;padding:9px;margin:10px 0;"
    "text-align:center;font-weight:bold;border-radius:20px}"
    ".f{border-top:1px solid #eee;padding:8px 8px 14px;font-size:12px;line-height:2;color:#5f6368;background:#f8f9fa}"
    ".f .m{line-height:1.6;margin:4px 0 0}"
    ".q,.u{border:1px solid #c4c7c5;border-radius:16px;padding:5px 10px;font-size:14px;box-sizing:border-box}"
    ".q{width:150px}.u{width:100%;margin:2px 0 6px}"
    "input[type=submit]{background:#0b57d0;color:#fff;border:0;border-radius:16px;padding:6px 12px;font-weight:bold}"
    ".hl{background:#fff3a0}"
    ".e{background:#fff4e5;border:1px solid #f0c890;padding:8px 10px;margin:8px 0;border-radius:10px}"
)

# Ciemny wygląd strony głównej i wyników: duże logo, zaokrąglone pole wyszukiwania z lupą (tabela zamiast flexboxa).
# Wysyłany tylko na tych stronach – czytnik ma barwy odwiedzanego serwisu.
DARK_STYLE = (
    "html.dk{background:#202124}"
    ".dk{background:#202124;color:#e8eaed}.dk a{color:#8ab4f8}"
    ".hm{padding:40px 10px 0;text-align:center}.hm .m{margin:12px 0 0}"
    ".logo{font-size:34px;font-weight:bold;letter-spacing:-1px;color:#fff;margin:0 0 20px}"
    ".logo span{color:#8ab4f8}"
    ".pill{width:100%;background:#303134;border:1px solid #5f6368;border-radius:24px}.pill td{padding:5px 0;vertical-align:middle}"
    ".pl{width:28px;text-align:center}.pl a{color:#e8eaed;font-size:22px}"
    ".pill .pq{padding:5px 0 5px 14px}.pill .pl+.pq{padding-left:2px}"
    ".pi{width:100%;background:#303134;border:0;color:#e8eaed;font-size:15px;padding:4px 0}"
    ".pr{width:36px;text-align:center}"
    ".hb{padding:22px 10px 10px;line-height:1.5}.hb p{margin:10px 0 0;text-align:center}"
    ".cd{display:block;background:#303134;border-radius:14px;padding:9px 12px;margin:0 0 8px;color:#e8eaed}"
    ".dk a.cd{color:#e8eaed}.cd b{font-size:22px;font-weight:normal;color:#fff}.cd .m{margin:0}"
    ".ch{display:inline-block;padding:3px 9px;margin:3px 1px;border:1px solid #5f6368;border-radius:14px;font-size:13px;font-weight:bold}"
    ".nw{white-space:nowrap}"
    ".sh{padding:8px 8px 2px}.sh .m{margin:6px 4px 0}.lg{font-size:20px;font-weight:bold;color:#fff;margin:0 0 8px 4px}"
    ".lg a{color:#fff}"
    ".dk .m{color:#9aa0a6}.dk .r{border-color:#3c4043}.dk .h{color:#9aa0a6}.dk .s{color:#bdc1c6}.dk h2{color:#e8eaed}"
    ".dk .b{background:#303134;border-color:#5f6368;color:#8ab4f8}.dk .e{background:#3b2a1a;border-color:#8a6d3b;color:#f6d7a7}"
    ".dk .u,.dk .q{background:#303134;color:#e8eaed;border-color:#5f6368}"
    ".ok{color:#81c995;font-size:12px;white-space:nowrap}"
    ".dk input[type=submit]{background:#8ab4f8;color:#202124}"
)

TEMPLATES = {
    "base.html": """<!DOCTYPE html>
<html lang="pl"{{ self.bodyattr() }}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>{% block title %}Szukaj{% endblock %}</title>
<style>{{ style }}</style>{% block extra_style %}{% endblock %}{% if theme %}
<style>{{ theme_css(theme) }}</style>{% endif %}{% if text_css %}
<style>{{ text_css }}</style>{% endif %}
{% block head %}{% endblock %}</head>
<body{% block bodyattr %}{% endblock %}>
{% block body %}{% endblock %}
</body>
</html>
""",
    "_form.html": """<form action="{{ url_for('search') }}" method="get">
<input class="q" type="text" name="q" value="{{ q or '' }}" maxlength="200">
<input type="submit" value="Szukaj">
</form>
""",
    "_nav.html": """<div class="bar"{% if not bottom %} id="g"{% endif %}>{% if theme and images %}<img class="ic" src="{{ url_for('image', u=theme.icon, r=theme.site, ic=theme.bar[1:]) }}" width="16" height="16" alt="">{% endif %}{% if q %}<a href="{{ url_for('search', q=q, p=rp, w=1) }}"{% if not bottom %} accesskey="7"{% endif %}>{% if request.args.get('l') %}Szukaj w sieci{% else %}&laquo; Wyniki{% endif %}</a> {% endif %}<a href="{{ url_for('home') }}"{% if not bottom %} accesskey="0"{% endif %}>Nowe szukanie</a></div>
""",
    "_settings.html": """<div class="f" id="d"><a href="{{ original }}" accesskey="9">[Oryginał]</a>{% if bookmark_url %} &middot; {% if bookmarked %}<a href="{{ url_for('bookmark_remove', u=bookmark_url, next=request.full_path) }}" accesskey="4">Usuń z zakładek</a>{% else %}<a href="{{ url_for('bookmark_add', u=bookmark_url, t=title, next=request.full_path) }}" accesskey="4">Dodaj do zakładek</a>{% endif %}{% endif %}<br>
{% if has_images and not saving %}<a href="{{ url_for('settings', k='obrazki', v=0 if images else 1, next=request.full_path) }}">Obrazki: {{ "wyłącz" if images else "włącz" }}</a> &middot; {% endif %}{% if has_links %}<a href="{{ url_for('settings', k='linki', v=0 if links else 1, next=request.full_path) }}">Linki w tekście: {{ "wyłącz" if links else "włącz" }}</a>{% endif %}{% if has_images and not saving or has_links %}<br>
{% endif %}Tekst:{% for size, label in (("s", "A-"), ("m", "A"), ("l", "A+"), ("xl", "A++")) %} {% if text_size == size %}<b>{{ label }}</b>{% else %}<a href="{{ url_for('settings', k='tekst', v=size, next=request.full_path) }}">{{ label }}</a>{% endif %}{% endfor %} &middot; <a href="{{ url_for('settings', k='oszcz', v=0 if saving else 1, next=request.full_path) }}">Oszczędzanie danych: {{ "wyłącz" if saving else "włącz" }}</a><br>
<span class="m">Dane w tym miesiącu: {{ data_mb|mb1 }} &middot; skróty: 1 wstecz, 3 dalej, <a href="#g" accesskey="2">2 góra</a>, <a href="#d" accesskey="8">8 dół</a>, 5 film, 4 zakładka, 7 wyniki, 0 nowe szukanie, 9 oryginał</span></div>
""",
    "_find_form.html": """<form action="{{ url_for('read') }}" method="get">
{% if fixed_url %}<input type="hidden" name="url" value="{{ fixed_url }}">{% else %}Link:<br><input class="u" type="text" name="url" value="" maxlength="2000"><br>
Szukane słowo (można pominąć):<br>{% endif %}<input class="q" type="text" name="s" value="{{ s or '' }}" maxlength="100">{% if q %}
<input type="hidden" name="q" value="{{ q }}"><input type="hidden" name="rp" value="{{ rp }}">{% endif %}
<input type="submit" value="{{ 'Szukaj na stronie' if fixed_url else 'Otwórz' }}">
</form>
""",
    "_pill.html": """<form action="{{ url_for('search') }}" method="get"><table class="pill" cellspacing="0" cellpadding="0"><tr>{% if plus %}<td class="pl"><a href="{{ url_for('link_page') }}">+</a></td>{% endif %}<td class="pq"><input class="pi" type="text" name="q" value="{{ q or '' }}" maxlength="200"></td><td class="pr"><input type="image" src="{{ url_for('icon', name='lupa') }}" width="20" height="20" alt="Szukaj" value="Szukaj"></td></tr></table></form>
""",
    "home.html": """{% extends "base.html" %}
{% block extra_style %}<style>{{ dark_style }}</style>{% endblock %}
{% block bodyattr %} class="dk"{% endblock %}
{% block body %}<div class="hm">
<div class="logo">Szuk<span>ajka</span></div>
{% set plus = True %}{% include "_pill.html" %}<p class="m">Wpisz hasło albo adres strony.</p>
</div>
<div class="hb">{% if weather %}<a class="cd" href="{{ url_for('weather_page') }}"><b>{{ weather.temp }}&deg;</b> {{ weather.city }}, {{ weather.desc }}{% for day in weather.days %}<br><span class="m">{{ day.label }} od {{ day.min }} do {{ day.max }}&deg;C, {{ day.desc }}</span>{% endfor %}</a>{% else %}<a class="cd" href="{{ url_for('weather_page') }}">Pogoda</a>{% endif %}
{% if rates %}<div class="cd"><span class="m">Kursy NBP</span><br>{% for code, value in rates.rates %}<span class="nw">{{ code }} {{ value }}</span>{% if not loop.last %} &middot; {% endif %}{% endfor %} <span class="m">zł</span></div>
{% endif %}<p><a href="{{ url_for('bookmarks') }}" accesskey="4" class="ch">Zakładki{% if bookmarks_count %} ({{ bookmarks_count }}){% endif %}</a> <a href="{{ url_for('settings', k='oszcz', v=0 if saving else 1, next='/') }}" class="ch">Oszczędzanie danych: {{ "wyłącz" if saving else "włącz" }}</a></p>
<p class="m">Dane z Szukajki w tym miesiącu: {{ data_mb|mb1 }} &middot; tekst:{% for size, label in (("s", "A-"), ("m", "A"), ("l", "A+"), ("xl", "A++")) %} {% if text_size == size %}<b>{{ label }}</b>{% else %}<a href="{{ url_for('settings', k='tekst', v=size, next='/') }}">{{ label }}</a>{% endif %}{% endfor %}</p></div>
{% endblock %}
""",
    "bookmarks.html": """{% extends "base.html" %}
{% block title %}Zakładki{% endblock %}
{% block extra_style %}<style>{{ dark_style }}</style>{% endblock %}
{% block bodyattr %} class="dk"{% endblock %}
{% block body %}<div class="sh"><div class="lg"><a href="{{ url_for('home') }}" accesskey="0">Szukajka</a></div></div>
<div class="w">
<h2>Zakładki</h2>
{% for url, title in items %}<div class="r"><a class="t" href="{{ url_for('read', url=url) }}">{{ title }}</a><br>
<span class="h">{{ url|host }}</span> &middot; <a class="o" href="{{ url_for('bookmark_remove', u=url, next=request.full_path) }}">usuń</a></div>
{% else %}<p>Nie masz jeszcze zakładek. Na dole każdej strony w czytniku jest &bdquo;Dodaj do zakładek&rdquo; (skrót: 4).</p>
{% endfor %}<p class="m">Zakładki są zapisane w telefonie (najwyżej ok. {{ 40 }} &ndash; najstarsze wypadają).</p>
</div>
{% endblock %}
""",
    "weather.html": """{% extends "base.html" %}
{% block title %}Pogoda{% endblock %}
{% block extra_style %}<style>{{ dark_style }}</style>{% endblock %}
{% block bodyattr %} class="dk"{% endblock %}
{% block body %}<div class="sh"><div class="lg"><a href="{{ url_for('home') }}" accesskey="0">Szukajka</a></div></div>
<div class="w">
{% if weather %}<h2>{{ weather.city }}: {{ weather.temp }}&deg;C</h2>
<p>{{ weather.desc }}</p>
{% for day in weather.days %}<div class="r"><b>{{ day.label }}</b>: od {{ day.min }} do {{ day.max }}&deg;C, {{ day.desc }}</div>
{% endfor %}{% else %}<div class="e">Nie znalazłem pogody dla &bdquo;{{ city }}&rdquo;. Sprawdź nazwę miejscowości.</div>
{% endif %}<form action="{{ url_for('weather_page') }}" method="get">Miejscowość:<br><input class="q" type="text" name="miasto" value="{{ city }}" maxlength="60">
<input type="submit" value="Pokaż"></form>
{% if rates %}<h2>Kursy walut</h2>
<p>{% for code, value in rates.rates %}{{ code }}: {{ value }} zł<br>{% endfor %}<span class="m">Średnie kursy NBP z {{ rates.date }}</span></p>
{% endif %}<p class="m">Pogoda: Open-Meteo / wttr.in. Miejscowość jest zapamiętana w telefonie.</p>
</div>
{% endblock %}
""",
    "link.html": """{% extends "base.html" %}
{% block title %}Masz dokładny link?{% endblock %}
{% block extra_style %}<style>{{ dark_style }}</style>{% endblock %}
{% block bodyattr %} class="dk"{% endblock %}
{% block body %}<div class="sh"><div class="lg"><a href="{{ url_for('home') }}">Szukajka</a></div></div>
<div class="w">
<h2>Masz dokładny link?</h2>
{% include "_find_form.html" %}<p class="m">Otwiera tę stronę od razu. Gdy podasz słowo, pokaże tylko fragmenty strony z tym słowem (polskie znaki można pominąć). Link wpisany w zwykłe pole wyszukiwania też otwiera stronę od razu.</p>
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
{% set bottom = True %}{% include "_nav.html" %}{% include "_settings.html" %}
{% endblock %}
""",
    "search.html": """{% extends "base.html" %}
{% block title %}{{ q }} - szukaj{% endblock %}
{% block extra_style %}<style>{{ dark_style }}</style>{% endblock %}
{% block bodyattr %} class="dk"{% endblock %}
{% block body %}<div class="sh"><div class="lg">Szukajka</div>
{% set plus = False %}{% include "_pill.html" %}<div class="m">wyniki{% if page > 1 %}, str. {{ page }}{% endif %}</div></div>
<div class="w">
{% if error %}<div class="e">{{ error }}</div>
{% endif %}{% for r in results %}<div class="r"><a class="t" href="{{ url_for('read', url=r.url, q=q, rp=page) }}">{{ r.title }}</a><br>
<span class="h">{{ r.host }}</span>{% if r.works %} <span class="ok">&#9654; filmy działają</span>{% endif %}{% if r.snippet %}<br><span class="s">{{ r.snippet }}</span>{% endif %} <a class="o" href="{{ r.url }}">[Oryginał]</a></div>
{% endfor %}{% if blocked_hidden %}<p class="m">Ukryto {{ blocked_hidden }} {{ "stronę, która blokuje" if blocked_hidden == 1 else ("strony, które blokują" if blocked_hidden % 10 in (2, 3, 4) and blocked_hidden % 100 not in (12, 13, 14) else "stron, które blokują") }} Szukajkę (ochrona przed botami). <a href="{{ url_for('search', q=q, p=page, all=1) }}">Pokaż</a></p>
{% endif %}{% if hidden %}<p class="m">Ukryto {{ hidden }} {{ "stronę" if hidden == 1 else ("strony" if hidden % 10 in (2, 3, 4) and hidden % 100 not in (12, 13, 14) else "stron") }}, na których filmy nie działają. <a href="{{ url_for('search', q=q, p=page, all=1) }}">Pokaż</a></p>
{% endif %}{% if not results and not error %}<p>Brak wyników.</p>
{% endif %}{% if has_more %}<a class="b" href="{{ url_for('search', q=q, p=page + 1, all=1 if show_all else None) }}" accesskey="3">Następna strona &raquo;</a>
{% endif %}{% if page > 1 %}<a class="b" href="{{ url_for('search', q=q, p=page - 1, all=1 if show_all else None) }}" accesskey="1">&laquo; Poprzednia strona</a>
{% endif %}<p class="m"><a href="{{ url_for('home') }}" accesskey="0">Nowe szukanie</a> &middot; skróty: 3 dalej, 1 wstecz, 0 nowe szukanie</p></div>
{% endblock %}
""",
    "read.html": """{% extends "base.html" %}
{% block title %}{{ title }}{% endblock %}
{% macro tl(text) %}{% if links %}{{ inline_links(text, q, rp) }}{% else %}{{ visible(text) }}{% endif %}{% endmacro %}
{% block head %}{% if score %}<style>{{ board_css }}</style>{% endif %}{% if film and film.mode in ("work", "busy") %}<meta http-equiv="refresh" content="{{ 8 if film.mode == 'work' else 15 }};url={{ url_for('read', url=url, q=q, rp=rp, wf=film.index, wfmt=film.fmt, wc=film.part, n=tick) }}#film{{ film.index }}">{% endif %}{% endblock %}
{% block body %}{% include "_nav.html" %}<div class="w">
{% if crumbs and page == 1 %}<div class="bc">{% for name, href in crumbs %}{% if not loop.first %} / {% endif %}{% if href %}<a href="{{ url_for('read', url=href, q=q, rp=rp) }}">{{ name }}</a>{% else %}{{ name }}{% endif %}{% endfor %}</div>
{% endif %}<h1>{{ title }}</h1>
<p class="m">{{ site_name or host }}{% if pages > 1 %} &middot; strona {{ page }} z {{ pages }}{% endif %}{% if rendered %} &middot; z JavaScriptem{% endif %}</p>
{% if score %}<div class="ib">{% include "_board.html" %}<a href="{{ url_for('live_board', m=score.href.rstrip('/').rsplit('/', 1)[-1], s=score.sport, l=score.league or None, u=url, q=q or None, rp=rp) }}"><b>Śledź na żywo</b></a> &middot; <a href="{{ url_for('read', url=url, q=q, rp=rp, n=tick) }}">Odśwież</a> &middot; <a href="{{ url_for('read', url=score.href, q=q, rp=rp) }}">Szczegóły</a> <span class="m">wg Flashscore</span></div>
{% endif %}{% if page == 1 %}{% for v in videos %}{% set i = loop.index %}{% set start = url_for('read', url=url, q=q, rp=rp, wf=i) ~ '#film' ~ i %}{% set what = "nagranie" if v.audio else "film" %}{% if not v.hide %}<div class="v" id="film{{ i }}">{% set live = film and film.index == i and film.mode == "done" and film.fmt in ("mp4", "mp3") %}{% set file = url_for('video_file', key=film.key, ext=film.fmt) if live else "" %}{% if live and film.fmt == "mp4" %}<video src="{{ file }}" controls playsinline preload="metadata"{% if images %} poster="{{ url_for('image', u=v.url, v=1, p=v.poster, f=v.fallback, r=site) }}"{% endif %}><a href="{{ file }}">Odtwórz film</a></video><br>{% elif images and not v.audio %}<a href="{{ start }}"><img src="{{ url_for('image', u=v.url, v=1, p=v.poster, f=v.fallback, r=site) }}" alt=""></a><br>{% elif images and v.fallback %}<a href="{{ start }}"><img src="{{ url_for('image', u=v.fallback, r=site, t=1) }}" alt=""></a><br>{% endif %}{% if live and film.fmt == "mp3" %}<audio src="{{ file }}" controls preload="none"><a href="{{ file }}">Odtwórz nagranie</a></audio><br>{% endif %}
{% if film and film.index == i %}{% set f = film %}{% set again = url_for('read', url=url, q=q, rp=rp, wf=i, wfmt=f.fmt, wc=f.part, n=tick) ~ '#film' ~ i %}{% if f.mode == "work" %}<b>Przygotowuję {{ what }}{% if f.part > 1 or (f.part_total and f.part_total > 1) %}, część {{ f.part }}{% endif %}&hellip;</b><br>
{% if f.status.state == "download" %}Pobieranie: {{ f.status.got|mb }}{% if f.status.progress %} ({{ f.status.progress }}%){% endif %}{% else %}Zmniejszanie dla telefonu: {{ f.status.progress }}%{% endif %}<br>
<a href="{{ again }}">Odśwież</a> <span class="m">&ndash; samo co 8 s</span>
{% elif f.mode == "busy" %}Serwer kończy inny film &ndash; {{ "to nagranie zacznie" if v.audio else "ten zacznie" }} się za chwilę.<br><a href="{{ again }}">Odśwież</a>
{% elif f.mode == "done" %}<a href="{{ url_for('video_file', key=f.key, ext=f.fmt) }}"{% if v.n == 1 %} accesskey="5"{% endif %}>{% if live %}Otwórz w odtwarzaczu telefonu{% else %}Odtwórz {{ what }}{% endif %} ({{ formats[f.fmt].name }}, {{ f.status.size|mb }})</a><br>
<span class="m">{% if f.part_total and f.part_total > 1 %}Część {{ f.part }} z {{ f.part_total }} &middot; {% endif %}{{ f.status.length|mmss }}</span><br>
{% if f.has_next %}<a href="{{ url_for('read', url=url, q=q, rp=rp, wf=i, wfmt=f.fmt, wc=f.part + 1) }}#film{{ i }}">Następna część{% if f.next_ready %} (gotowa){% endif %} &raquo;</a><br>
{% endif %}{% if f.part > 1 %}<a href="{{ url_for('read', url=url, q=q, rp=rp, wf=i, wfmt=f.fmt, wc=f.part - 1) }}#film{{ i }}">&laquo; Poprzednia część</a><br>
{% endif %}<span class="m"><a href="{{ url_for('video_file', key=f.key, ext=f.fmt, d=1) }}">Zapisz w telefonie</a>{% if f.other %} &middot; <a href="{{ url_for('read', url=url, q=q, rp=rp, wf=i, wfmt=f.other, wc=f.part) }}#film{{ i }}">Nie działa? {{ formats[f.other].name }}</a>{% endif %}</span>
{% else %}{{ f.status.message }}<br>{% if f.status.blocked %}<a href="{{ original }}">Otwórz bezpośrednio w Operze</a>{% else %}<a href="{{ url_for('read', url=url, q=q, rp=rp, wf=i, wfmt=f.fmt, wc=f.part, znowu=1) }}#film{{ i }}">Spróbuj ponownie</a>{% if f.other %} &middot; <a href="{{ url_for('read', url=url, q=q, rp=rp, wf=i, wfmt=f.other, wc=f.part) }}#film{{ i }}">{{ formats[f.other].name }}</a>{% endif %}{% endif %}
{% endif %}{% else %}<a href="{{ start }}"{% if v.n == 1 %} accesskey="5"{% endif %}>{% if v.audio %}Nagranie{% else %}Film{% endif %}{% if shown_videos > 1 %} {{ v.n }}{% endif %}: {{ "posłuchaj" if v.audio else "obejrzyj" }} na telefonie</a>{% endif %}</div>
{% endif %}{% endfor %}{% endif %}{% for it in items %}{% if it.kind == "item" %}<div class="it">{% if it.img and images %}<img src="{{ url_for('image', u=it.img, r=site, t=1) }}" alt="">{% endif %}<a{% if it.img and images %} class="n"{% endif %} href="{{ url_for('read', url=it.href, q=q, rp=rp) }}">{{ it.text }}</a></div>
{% elif it.kind == "grid" %}{% if images %}<div class="gr">{% for im in it.imgs %}<a href="{{ url_for('image', u=im.src, r=site, hq=1) }}" target="_blank"><img src="{{ url_for('image', u=im.src, r=site, t=2) }}" alt="{{ im.alt or 'obrazek' }}"></a>{% endfor %}</div>
{% endif %}{% elif it.kind == "img" %}{% if images %}<div class="ph"><a href="{{ url_for('image', u=it.href, r=site, hq=1) }}" target="_blank"><img src="{{ url_for('image', u=it.href, r=site) }}" alt="{{ it.text or 'obrazek' }}"></a></div>
{% endif %}{% elif it.kind == "h" %}<h2>{{ it.text }}</h2>
{% elif it.kind == "pl" %}<p>{{ tl(it.text) }}</p>
{% elif it.kind == "ib" %}<div class="ib">{% for r in infobox_rows(it.text) %}{% if r.img %}{% if images %}<div class="ibi">{% for im in r.img %}<span class="{{ 'ib2' if r.img|length > 1 else 'ib1' }}"><a href="{{ url_for('image', u=im.src, r=site, hq=1) }}" target="_blank"><img src="{{ url_for('image', u=im.src, r=site, t=1 if r.img|length > 1 else None) }}" alt=""></a>{% if im.cap %}<br>{{ tl(im.cap) }}{% endif %}</span>{% endfor %}</div>
{% endif %}{% elif r.t %}<div class="ibt">{{ r.t }}</div>
{% elif r.t2 %}<b>{{ r.t2 }}</b><br>
{% elif r.l %}<b>{{ r.l }}:</b> {{ tl(r.v) }}<br>
{% else %}{{ tl(r.v) }}<br>
{% endif %}{% endfor %}</div>
{% else %}<p>{{ it.text }}</p>
{% endif %}{% endfor %}{% if page < pages %}<a class="b" href="{{ url_for('read', url=url, q=q, rp=rp, page=page + 1) }}" accesskey="3">Dalej &raquo; ({{ page }}/{{ pages }})</a>
{% endif %}{% if page > 1 %}<a class="b" href="{{ url_for('read', url=url, q=q, rp=rp, page=page - 1) }}" accesskey="1">&laquo; Wstecz</a>
{% endif %}{% set fixed_url = url %}{% include "_find_form.html" %}</div>
{% set bottom = True %}{% include "_nav.html" %}{% include "_settings.html" %}
{% endblock %}
""",
    "film.html": """{% extends "base.html" %}
{% block title %}{{ title }}{% endblock %}
{% block head %}{% if refresh %}<meta http-equiv="refresh" content="{{ refresh }};url={{ here }}">{% endif %}{% endblock %}
{% block body %}<div class="bar">{% if theme and images %}<img class="ic" src="{{ url_for('image', u=theme.icon, r=theme.site, ic=theme.bar[1:]) }}" width="16" height="16" alt="">{% endif %}{% if referer %}<a href="{{ url_for('read', url=referer, q=q, rp=rp) }}">&laquo; Strona</a> {% elif q %}<a href="{{ url_for('search', q=q, p=rp) }}">&laquo; Wyniki</a> {% endif %}<a href="{{ url_for('home') }}">Nowe szukanie</a></div>
<div class="w">
<h1>{{ title }}</h1>
<p class="m">{{ host }}{% if status and status.total %} &middot; {{ status.total|mmss }}{% endif %}{% if part_total and part_total > 1 %} &middot; część {{ part }} z {{ part_total }}{% elif part > 1 %} &middot; część {{ part }}{% endif %}</p>
{% if poster_img and (mode == "choose" or (mode == "done" and fmt != "mp4")) and not audio %}<div class="ph"><img src="{{ poster_img }}" alt=""></div>
{% endif %}{% if mode == "choose" %}{% for f, info in formats.items() %}<a class="b" href="{{ link(f=f) }}">{{ info.name }}{% if ready[f] %} &ndash; gotowy{% endif %}</a>
<p class="m">{{ info.about }}</p>
{% endfor %}<p>Serwer pobiera film i zmniejsza go dla telefonu. Pierwsza część ({{ first_minutes }} min) jest gotowa najszybciej, zwykle po 1&ndash;2 minutach. Kolejne części serwer przygotowuje sam w tle, gdy oglądasz poprzednią. Gotowy plik otworzy odtwarzacz telefonu.</p>
<p class="m">Zacznij od MP4. Gdy telefon go nie odtworzy, wybierz 3GP.</p>
{% elif mode == "busy" %}<p>Serwer przygotowuje teraz inny film. Ten zacznie się zaraz po nim &ndash; strona odświeża się sama.</p>
<a class="b" href="{{ here }}">Odśwież</a>
{% elif mode == "work" %}<p><b>Przygotowuję {{ "nagranie" if audio else "film" }} {{ fmt_name }}&hellip;</b></p>
<p>{% if status.state == "download" %}Pobieranie: {{ status.got|mb }}{% if status.progress %} ({{ status.progress }}%){% endif %}{% else %}Zmniejszanie dla telefonu: {{ status.progress }}%{% endif %}</p>
<a class="b" href="{{ here }}">Odśwież</a>
<p class="m">Strona odświeża się sama co {{ refresh }} s. Możesz też wyjść i wrócić tu później.</p>
{% elif mode == "done" %}{% if fmt == "mp4" %}<div class="v"><video src="{{ url_for('video_file', key=key, ext=fmt) }}" controls playsinline preload="metadata"{% if poster_img %} poster="{{ poster_img }}"{% endif %}></video></div>
{% elif fmt == "mp3" %}<div class="v"><audio src="{{ url_for('video_file', key=key, ext=fmt) }}" controls preload="none"></audio></div>
{% endif %}<a class="b" href="{{ url_for('video_file', key=key, ext=fmt) }}" accesskey="5">Odtwórz {{ "nagranie" if fmt == "mp3" else "film" }} ({{ fmt_name }}, {{ status.size|mb }})</a>
<p class="m">{% if status.length %}Czas: {{ status.length|mmss }}. {% endif %}Plik otworzy odtwarzacz telefonu.</p>
<p><a href="{{ url_for('video_file', key=key, ext=fmt, d=1) }}">Zapisz w pamięci telefonu</a></p>
{% if has_next %}<a class="b" href="{{ link(f=fmt, c=part + 1) }}" accesskey="3">Następna część ({{ part + 1 }}){% if next_ready %} &ndash; gotowa{% endif %} &raquo;</a>
{% if not next_ready %}<p class="m">Następna część przygotowuje się w tle.</p>
{% endif %}{% endif %}{% if part > 1 %}<a class="b" href="{{ link(f=fmt, c=part - 1) }}" accesskey="1">&laquo; Poprzednia część</a>
{% endif %}{% if other %}<p><a href="{{ link(f=other, c=part) }}">Nie działa? Spróbuj {{ formats[other].name }}</a></p>
{% endif %}{% else %}<div class="e">{{ status.message }}</div>
{% if status.blocked %}<a class="b" href="{{ referer or src }}">Otwórz bezpośrednio w Operze</a>
<p><a href="{{ link(f=fmt, c=part, znowu=1) }}">Spróbuj ponownie w Szukajce</a></p>
{% else %}<a class="b" href="{{ link(f=fmt, c=part, znowu=1) }}">Spróbuj ponownie</a>
{% endif %}{% if other %}
<p><a href="{{ link(f=other, c=part) }}">Spróbuj {{ formats[other].name }}</a></p>
{% endif %}{% endif %}</div>
<div class="f"><a href="{{ src }}">[Oryginał filmu]</a></div>
{% endblock %}
""",
    "_board.html": """{% if score.league or score.when %}<div class="m lg2">{{ score.league }}{% if score.league and score.when %} &middot; {% endif %}{{ score.when }}</div>{% endif %}<b>{% if score.state == "live" %}Na żywo{% if score.status %} &middot; {{ score.status }}{% endif %}{% elif score.state == "fin" %}Koniec meczu{% else %}Przed meczem{% if score.status %} &middot; {{ score.status }}{% endif %}{% endif %}</b>
<table class="sb" cellspacing="0"><tr><th></th>{% for p in score.periods %}<th>{{ p.label }}</th>{% endfor %}<th>{{ score.total }}</th></tr>
<tr><td class="n">{% if score.serve == "home" %}<span class="sv">&#9679;</span> {% endif %}{{ score.home }}</td>{% for p in score.periods %}<td>{{ p.h }}</td>{% endfor %}<td class="t">{{ score.h }}</td></tr>
<tr><td class="n">{% if score.serve == "away" %}<span class="sv">&#9679;</span> {% endif %}{{ score.away }}</td>{% for p in score.periods %}<td>{{ p.a }}</td>{% endfor %}<td class="t">{{ score.a }}</td></tr></table>
""",
    "board.html": """{% extends "base.html" %}
{% block title %}{{ score.home }} - {{ score.away }} {{ score.score }}{% endblock %}
{% block head %}<style>{{ board_css }}</style>{% if score.state != "fin" %}<meta http-equiv="refresh" content="30;url={{ url_for('live_board', m=match_id, s=sport or None, l=score.league or None, u=article or None, q=q or None, rp=rp, n=tick) }}">{% endif %}{% endblock %}
{% block body %}<div class="bar">{% if article %}<a href="{{ url_for('read', url=article, q=q, rp=rp) }}">&laquo; Artykuł</a> {% endif %}<a href="{{ url_for('home') }}">Nowe szukanie</a></div>
<div class="w"><div class="ib">{% include "_board.html" %}</div>
{% for e in score.events %}<div class="r"><b>{{ e.minute }}</b> {{ e.what }}: {{ e.who }}</div>
{% endfor %}{% for sec in stats %}{% if sec.section %}<h2>{{ sec.section }}</h2>{% endif %}{% for r in sec.rows %}<table class="sx" cellspacing="0"><tr><td>{{ r.h }}</td><td class="c">{{ r.label }}</td><td class="r">{{ r.a }}</td></tr></table>
<table class="bt" cellspacing="0"><tr><td width="{{ 50 - (r.hp / 2)|round|int }}%" class="bg"></td><td width="{{ (r.hp / 2)|round|int }}%" class="bh"></td><td width="{{ (r.ap / 2)|round|int }}%" class="ba"></td><td width="{{ 50 - (r.ap / 2)|round|int }}%" class="bg"></td></tr></table>
{% endfor %}{% endfor %}<a class="b" href="{{ url_for('live_board', m=match_id, s=sport or None, l=score.league or None, u=article or None, q=q or None, rp=rp, n=tick) }}" accesskey="5">Odśwież teraz</a>
<p class="m">{% if score.state != "fin" %}Wynik odświeża się sam co 30 s. {% endif %}Dane: Flashscore. <a href="{{ url_for('read', url=score.href, q=q, rp=rp) }}">Szczegóły i statystyki</a></p></div>
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
            if kind not in ("h", "p", "pl"):
                continue
            text = visible(text)
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
        elif kind == "gi":
            if not items or items[-1]["kind"] != "grid":
                items.append({"kind": "grid", "imgs": []})
            items[-1]["imgs"].append({"src": href, "alt": text})
        else:
            items.append({"kind": kind, "text": text, "href": href})
        thumb = None
    return items


app = Flask(__name__)
app.jinja_loader = DictLoader(TEMPLATES)
app.jinja_env.globals["style"] = STYLE
app.jinja_env.globals["theme_css"] = theme_css
app.jinja_env.globals["dark_style"] = DARK_STYLE
app.jinja_env.globals.update(inline_links=inline_links, visible=visible, infobox_rows=infobox_rows)
app.jinja_env.filters["mmss"] = mmss
app.jinja_env.filters["mb"] = megabytes
app.jinja_env.filters["host"] = lambda url: host_of(url)
app.jinja_env.filters["mb1"] = lambda value: f"{value:.1f} MB".replace(".", ",") if value >= 1 else f"{round(value * 1000)} KB"


def video_progress(src, referer, fmt, part, retry=False):
    """Stan przygotowania części filmu; uruchamia zadanie, gdy trzeba (także następną część w tle, gdy ta jest gotowa).
    Zwraca dict: mode (work/busy/done/error), status, key, fmt, other, part, part_total, has_next, next_ready."""
    key = video_key(src, fmt, part - 1)
    info = {"key": key, "fmt": fmt, "other": {"mp4": "3gp", "3gp": "mp4"}.get(fmt), "part": part, "status": None,
            "part_total": None, "has_next": False, "next_ready": False}
    status = read_status(key)
    if status is None or (status.get("state") == "error" and retry):
        if not start_video_job(key, src, referer, fmt, part - 1):
            return dict(info, mode="busy")
        status = read_status(key) or {"state": "download", "got": 0, "progress": 0}
    info["status"] = status
    state = status.get("state")
    if status.get("total"):
        info["part_total"] = part_count(status["total"])
        info["has_next"] = part < info["part_total"]
    if state == "done" and info["has_next"]:  # oglądasz tę część – następna przygotowuje się w tle
        next_key = video_key(src, fmt, part)
        start_video_job(next_key, src, referer, fmt, part, auto=True)
        info["next_ready"] = (read_status(next_key) or {}).get("state") == "done"
    info["mode"] = "work" if state in VIDEO_ACTIVE else ("done" if state == "done" else "error")
    return info


def complete_theme(html, url):
    try:
        site_theme(html, url, fetch=True)
    except Exception:
        log.exception("motyw strony (w tle): %s", url)


def server_timing(article, total):
    """Nagłówek Server-Timing: ile trwało pobranie strony, wydobycie treści i odczyt wyglądu (do pomiarów z zewnątrz)."""
    parts = [f"{name};dur={int(value * 1000)}" for name, value in (article.get("timing") or {}).items()]
    return ", ".join(parts + [f"razem;dur={int(total * 1000)}"])


def video_items(article):
    """Filmy i nagrania dla czytnika: adres, miniatura podana przez stronę i zdjęcie strony jako zapasowa miniatura."""
    posters = article.get("posters") or {}
    return ([{"url": v, "poster": posters.get(v), "fallback": posters.get(""), "audio": False} for v in article.get("videos", [])]
            + [{"url": a, "poster": None, "fallback": posters.get(""), "audio": True} for a in article.get("audios", [])])


@app.route("/")
def home():
    weather, rates = home_widgets(user_city())
    return render_template("home.html", q="", weather=weather, rates=rates, bookmarks_count=len(read_bookmarks()))


@app.route("/link")
def link_page():
    return render_template("link.html", q="")


_icons = {}


def draw_magnifier():
    """Ikona lupy (PNG z przezroczystością, 40 px – wyświetlana jako 20 px, ostra także na gęstszych ekranach)."""
    image = Image.new("RGBA", (40, 40), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    color = (232, 234, 237, 255)
    draw.ellipse((5, 5, 27, 27), outline=color, width=4)
    draw.line((25, 25, 35, 35), fill=color, width=5)
    out = io.BytesIO()
    image.save(out, "PNG", optimize=True)
    return out.getvalue()


@app.route("/ikona/<name>.png")
def icon(name):
    if name != "lupa":
        abort(404)
    if name not in _icons:
        _icons[name] = draw_magnifier()
    return Response(_icons[name], mimetype="image/png", headers={"Cache-Control": "public, max-age=604800"})


# ---------- Strony blokujące serwer Szukajki (ochrona przed botami) – nie pokazujemy ich w wynikach ----------
BLOCKED_COOKIE = "blok"
BLOCKED_DAYS = 7  # blokady bywają chwilowe (np. limit zapytań) – po tygodniu sprawdzamy stronę znowu
BLOCKED_MAX = 60
blocked_memory = DiskCache("blokady", ttl=3 * 24 * 3600, max_files=3000)  # host -> True (blokuje) / False (wpuszcza)
_probing, _probing_lock = set(), threading.Lock()


def site_host(url):
    host = (urlparse(url).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def read_blocked_cookie():
    """{host: dzień zapisu} z ciasteczka (bez wpisów starszych niż BLOCKED_DAYS)."""
    today = int(time.time() // 86400)
    out = {}
    for entry in (request.cookies.get(BLOCKED_COOKIE) or "").split("|"):
        host, _, day = entry.rpartition("~")
        if host and day.isdigit() and today - int(day) < BLOCKED_DAYS and re.fullmatch(r"[a-z0-9.-]{1,100}", host):
            out[host] = int(day)
    return out


def encode_blocked_cookie(hosts):
    items = sorted(hosts.items(), key=lambda kv: -kv[1])[:BLOCKED_MAX]
    return "|".join(f"{h}~{d}" for h, d in items)


def probe_blocked(url):
    """Szybkie sprawdzenie strony z wyników: czy wpuszcza serwer Szukajki. Wynik trafia do pamięci (wg hosta)."""
    host = site_host(url)
    try:
        _, resp = http_request(url)
        try:
            blocked = is_blocked(resp) if resp.status_code >= 400 else bool(
                CHALLENGE_TITLE.search(next(resp.iter_content(8192), b"").decode("latin-1")))
        finally:
            resp.close()
    except FetchError:
        return  # strona nie odpowiada – to nie blokada, nie zapamiętujemy
    except Exception:
        log.exception("sprawdzanie blokady: %s", url)
        return
    finally:
        with _probing_lock:
            _probing.discard(host)
    blocked_memory.set(host, blocked)


def blocked_state(host, cookie):
    if host in cookie:
        return True
    return blocked_memory.get(host)


def check_blocked(items, cookie):
    """Uzupełnia r["blocked"] (True/False/None); nieznane strony sprawdza równolegle, czekając najwyżej PROBE_WAIT s."""
    unknown = {}
    for r in items:
        r["blocked"] = blocked_state(site_host(r["url"]), cookie)
        if r["blocked"] is None and not is_video_url(r["url"]):
            unknown.setdefault(site_host(r["url"]), r["url"])
    if unknown and PROBE_WAIT > 0:
        threads = []
        for host, url in unknown.items():
            with _probing_lock:
                if host in _probing:
                    continue
                _probing.add(host)
            thread = threading.Thread(target=probe_blocked, args=(url,), daemon=True)
            thread.start()
            threads.append(thread)
        deadline = time.monotonic() + PROBE_WAIT
        for thread in threads:  # wolne strony sprawdzają się dalej w tle – przydadzą się przy następnym szukaniu
            thread.join(max(0.0, deadline - time.monotonic()))
        for r in items:
            if r["blocked"] is None:
                r["blocked"] = blocked_memory.get(site_host(r["url"]))


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
    sites = dict(reversed(read_video_sites()))
    items = [dict(r, host=host_of(r["url"]), works=site_videos_work(urlparse(r["url"]).hostname, sites)) for r in results]
    show_all = bool(request.args.get("all"))
    cookie = read_blocked_cookie()
    check_blocked(items, cookie)
    blocked_hidden = 0 if show_all else sum(1 for r in items if r["blocked"])
    if not show_all:
        items = [r for r in items if not r["blocked"]]
    hidden = 0
    if VIDEO_QUERY.search(query) and not show_all:  # szukanie filmów: bez stron, na których filmy nie działają
        hidden = sum(1 for r in items if r["works"] is False)
        items = [r for r in items if r["works"] is not False]
    if items and PREFETCH_RESULTS:
        prefetch_articles([r["url"] for r in items[:PREFETCH_RESULTS] if not is_video_url(r["url"])])
    body = render_template(
        "search.html", q=query, page=page, offset=(page - 1) * RESULTS_PER_PAGE,
        results=items, has_more=has_more, error=error, hidden=hidden, blocked_hidden=blocked_hidden, show_all=show_all,
    )
    resp = make_response(body, 502 if error else 200)
    today = int(time.time() // 86400)
    known = {site_host(r["url"]): blocked_memory.get(site_host(r["url"])) for r in results}
    updated = dict(cookie)
    updated.update({h: today for h, b in known.items() if b and h not in cookie})
    for h, b in known.items():
        if b is False:
            updated.pop(h, None)  # strona znowu wpuszcza serwer
    if updated != cookie:
        resp.set_cookie(BLOCKED_COOKIE, encode_blocked_cookie(updated), max_age=BLOCKED_DAYS * 86400, samesite="Lax")
    return resp


# ---------- Wynik na żywo ----------
# Relacje „na żywo” pokazują wynik w widżetach JavaScript (np. Statscore), których czytnik nie uruchomi. Gdy tytuł
# strony wygląda na relację meczu („A - B … na żywo / wynik / relacja”), bierzemy wynik z m.flashscore.pl – lekkiej
# wersji Flashscore dla telefonów (zwykły HTML z listą dzisiejszych meczów).
LIVE_TRIGGER = re.compile(r"wynik|żywo|zywo|\blive\b|relacj|online", re.I)
LIVE_SPORTS = (  # ścieżka na m.flashscore.pl, słowa rozpoznające dyscyplinę (w adresie, tytule, ścieżce nawigacji)
    ("tenis/", ("tenis", "wta", "atp", "wimbledon", "roland garros", "us open", "australian open")),
    ("siatkowka/", ("siatk", "plusliga", "volley")),
    ("koszykowka/", ("koszyk", "nba", "euroleague", "basket")),
    ("hokej/", ("hokej", "nhl")),
    ("pilka-reczna/", ("reczn", "handball")),
    ("", ("pilka", "nozna", "football", "soccer", "ekstraklasa", "liga", "uefa", "fifa", "mundial", "puchar")),
)
LIVE_STOPWORDS = {"na", "zywo", "live", "wynik", "wyniki", "relacja", "relacje", "online", "mecz", "meczu", "transmisja",
                  "gdzie", "ogladac", "tv", "stream", "the", "fc", "sk", "kks", "i", "w", "o", "z"}
FLASHSCORE = "https://m.flashscore.pl/"
flashscore_cache = TTLCache(maxsize=12, ttl=30)
LIVE_WAIT = 3.0  # najwyżej tyle s czekamy na Flashscore – czytnik nie może przez to zwolnić


def live_pairs(title):
    """Pary stron meczu z tytułu: [(słowa_gospodarzy, słowa_gości)] – po obu stronach separatora „-”, „–” albo „vs”."""
    pairs = []
    for match in re.finditer(r"\s(?:-|–|—|vs\.?)\s", title):
        left = re.split(r"[:.|,;!?]", title[:match.start()])[-1]
        right = re.split(r"[:.|,;!?]|\s(?:-|–|—)\s", title[match.end():])[0]
        words = lambda text: [w for w in re.findall(r"[a-z0-9]{3,}", fold(text)) if w not in LIVE_STOPWORDS]
        home, away = words(left)[-3:], words(right)[:3]
        if home and away:
            pairs.append((home, away))
    return pairs


def flashscore_matches(path):
    """Dzisiejsze mecze z m.flashscore.pl/<path>: [{home, away, score, extra, status, state, href}]."""
    cached = flashscore_cache.get(path)
    if cached is not None:
        return cached
    _, resp = http_request(FLASHSCORE + path)
    html = decode_html(read_body(resp, limit=1_000_000), resp)
    start = html.find('id="score-data"')
    matches, league = [], ""
    for chunk in re.split(r"<br\s*/?>", html[html.find(">", start) + 1:]) if start >= 0 else []:
        heading = re.search(r"<h4>(.*?)</h4>", chunk, re.S)
        if heading:
            league = squash(unescape(re.sub(r"<a .*?</a>|<[^>]+>", " ", heading.group(1))))
        link = re.search(r'<a href="(/mecz/[A-Za-z0-9]+/)" class="([a-z]+)">(.*?)</a>(.*)', chunk, re.S)
        if not link:
            continue
        head = chunk[:link.start()]
        status = re.search(r"<span[^>]*>([^<]*)</span>", head)
        names = squash(unescape(re.sub(r"<[^>]+>", " ", re.sub(r"<span[^>]*>[^<]*</span>|<h4>.*?</h4>", " ", head, flags=re.S))))
        home, sep, away = names.partition(" - ")
        if not sep:
            continue
        matches.append({
            "home": home.strip(), "away": away.strip(), "href": FLASHSCORE + link.group(1)[1:], "state": link.group(2),
            "score": squash(unescape(re.sub(r"<[^>]+>", "", link.group(3)))).replace(" ", "") or "-",
            "extra": squash(unescape(re.sub(r"<[^>]+>", "", link.group(4)))), "status": squash(status.group(1)) if status else "",
            "league": league,
        })
    flashscore_cache.set(path, matches)
    return matches


FS_EVENT_NAMES = {"y-card": "żółta kartka", "r-card": "czerwona kartka", "yr-card": "czerwona kartka (2. żółta)",
                  "soccer-ball": "gol", "soccer-ball-own": "gol samobójczy", "penalty-missed": "niewykorzystany karny"}
BOARD_CSS = (".sb{border-collapse:collapse;width:100%;margin:6px 0}.sb th,.sb td{padding:3px 4px;text-align:center;"
             "border-bottom:1px solid rgba(128,128,128,.3)}.sb th{font-size:11px;font-weight:normal}.sb .n{text-align:left;"
             "font-weight:bold}.sb .t{font-weight:bold;font-size:16px}.sv{color:#d93025}.lg2{font-size:12px;margin:0 0 4px}"
             ".sx{width:100%;margin:6px 0 0}.sx td{padding:0;font-size:12px}.sx .c{text-align:center}.sx .r{text-align:right}"
             ".bt{width:100%;border-collapse:collapse;margin:2px 0 4px}.bt td{height:5px;padding:0;font-size:1px}"
             ".bh{background:#34a853}.ba{background:#e8508a}.bg{background:rgba(128,128,128,.25)}")
app.jinja_env.globals["board_css"] = BOARD_CSS


def period_label(label, number):
    label = squash(label)
    match = re.match(r"Set (\d+)", label)
    if match:
        return "S" + match.group(1)
    match = re.match(r"(\d+)\. (\w)", label)  # 1. połowa, 2. tercja, 3. kwarta
    return f"{match.group(1)}{match.group(2)}." if match else (label[:6] or str(number))


def split_score(text):
    home, _, away = (text or "").partition("-")
    return home.strip() or "-", away.strip() or "-"


def board_from_list(m):
    """Plansza z samej listy meczów (gdy strona szczegółów nie odpowie): okresy z nawiasu „(7-6,0-1)”."""
    tennis = m.get("sport") == "tenis/"
    periods = [{"label": f"S{i}" if tennis else str(i), "h": h, "a": a}
               for i, (h, a) in enumerate((split_score(x) for x in re.findall(r"\d+\s*-\s*\d+", m.get("extra", ""))), 1)]
    h, a = split_score(m["score"])
    return dict(m, periods=periods, h=h, a=a, serve=None, events=[], total="Sety" if tennis else "Wynik")


def flashscore_match(m):
    """Plansza meczu ze strony szczegółów m.flashscore.pl: nazwy, serwujący, wynik, okresy, status, zdarzenia."""
    cached = flashscore_cache.get(m["href"])
    if cached is not None:
        return dict(cached, league=m.get("league") or cached.get("league", ""), sport=m.get("sport") or cached.get("sport", ""))
    _, resp = http_request(m["href"])
    html = decode_html(read_body(resp, limit=600_000), resp)
    head = re.search(r"<h3>(.*?)</h3>", html, re.S)
    main = re.search(r'<div class="detail"><span class="([a-z]+)"><b>([^<]*)</b></span>', html)
    if not head or not main:
        return board_from_list(m)
    head = head.group(1)
    sep = head.find(" - ")
    serve = head.find("tennis-serve")
    names = [squash(unescape(re.sub(r"<[^>]+>", "", part))) for part in (head[:sep], head[sep + 3:])] if sep > 0 else []
    statuses = re.findall(r'<div class="detail"><span class="[a-z]+">([^<]*)</span></div>', html)
    when = re.search(r'<div class="detail">(\d{2}\.\d{2}\.\d{4} \d{2}:\d{2})</div>', html)
    periods = [{"label": period_label(label, i), "h": split_score(score)[0], "a": split_score(score)[1]}
               for i, (label, score) in enumerate(re.findall(r"<h4>([^<:]+):\s*<b>([^<]*)</b></h4>", html), 1)]
    events = []
    for minute, icon, text in re.findall(r'<div class="incident[^"]*"><p class="i-field time">([^<]*)</p>'
                                          r'<p class="i-field icon ([a-z-]+)">.*?</p>(.*?)</div>', html, re.S):
        if icon != "substitution":
            events.append({"minute": squash(minute), "what": FS_EVENT_NAMES.get(icon, icon.replace("-", " ")),
                           "who": squash(unescape(re.sub(r"<[^>]+>", " ", text)))})
    h, a = split_score(unescape(main.group(2)).replace("\xa0", ""))
    board = dict(m, home=names[0] if len(names) == 2 else m["home"], away=names[1] if len(names) == 2 else m["away"],
                 state=main.group(1), score=f"{h}-{a}", h=h, a=a, status=squash(statuses[0]) if statuses else m.get("status", ""),
                 serve=None if serve < 0 else ("home" if serve < sep else "away"), periods=periods, events=events,
                 when=when.group(1) if when else "",
                 total="Sety" if any(p["label"].startswith("S") for p in periods) or m.get("sport") == "tenis/" else "Wynik")
    flashscore_cache.set(m["href"], board)
    return board


def flashscore_stats(href):
    """Statystyki meczu (zakładka „Statystyki” m.flashscore.pl): [{section, rows: [{label, h, a, hp, ap}]}]."""
    key = href + "#stat"
    cached = flashscore_cache.get(key)
    if cached is not None:
        return cached
    _, resp = http_request(href + "?t=statystyki")
    html = decode_html(read_body(resp, limit=800_000), resp)
    sections = []
    for part in re.split(r'(?=<div class="sectionHeader)', html)[1:]:
        title = re.search(r'<div class="sectionHeader[^"]*">([^<]*)</div>', part)
        rows = []
        for block in part.split('data-testid="wcl-statistics"')[1:]:
            values = re.findall(r'<div class="wcl-value_[^"]*">([^<]*)</div>', block)
            label = re.search(r'data-testid="wcl-simple-text-01">([^<]*)<', block)
            home = re.search(r'data-side="home" data-percentage="([\d.]+)"', block)
            away = re.search(r'data-side="away" data-percentage="([\d.]+)"', block)
            if len(values) >= 2 and label:
                hp = round(float(home.group(1)) * 100) if home else 50
                ap = round(float(away.group(1)) * 100) if away else 100 - hp
                rows.append({"label": unescape(label.group(1)), "h": unescape(values[0]), "a": unescape(values[-1]),
                             "hp": max(0, min(100, hp)), "ap": max(0, min(100, ap))})
        if rows:
            sections.append({"section": unescape(title.group(1)) if title else "", "rows": rows})
    flashscore_cache.set(key, sections)
    return sections


def find_live_score(title, hints):
    pairs = live_pairs(title)
    if not pairs:
        return None
    text = fold(" ".join(hints))
    path = next((p for p, words in LIVE_SPORTS if any(w in text for w in words)), "")
    has = lambda tokens, name: any(re.search(rf"\b{t}\b", fold(name)) for t in tokens)
    found = []
    for m in flashscore_matches(path):
        for home, away in pairs:
            if (has(home, m["home"]) and has(away, m["away"])) or (has(home, m["away"]) and has(away, m["home"])):
                found.append(m)
                break
    found.sort(key=lambda m: {"live": 0, "sched": 1, "fin": 2}.get(m["state"], 3))
    if not found:
        return None
    match = dict(found[0], sport=path)
    try:
        return flashscore_match(match)
    except FetchError:
        return board_from_list(match)


def live_score(article):
    """Wynik meczu z relacji (albo None). Czeka na Flashscore najwyżej LIVE_WAIT s – wolniejszy wynik pojawi się
    po odświeżeniu (zostaje w pamięci podręcznej)."""
    title = article.get("title") or ""
    site = fold(urlparse(article.get("url", "")).hostname or "")
    if not LIVE_TRIGGER.search(title + " " + article.get("url", "")):
        return None
    if not [pair for pair in live_pairs(title) if not all(word in site for word in pair[1])]:
        return None  # „… - Onet” to tylko nazwa serwisu w tytule, nie mecz
    hints = [article.get("url", ""), title] + [name for name, _ in article.get("crumbs") or []]
    box = {}

    def work():
        try:
            box["score"] = find_live_score(title, hints)
        except FetchError as err:
            log.info("wynik na żywo: %s", err.message)
        except Exception:
            log.exception("wynik na żywo")

    thread = threading.Thread(target=work, daemon=True)
    thread.start()
    thread.join(LIVE_WAIT)
    return box.get("score")


@app.route("/wynik")
def live_board():
    """Sama plansza meczu, odświeżana co 30 s – można śledzić wynik bez przeładowywania artykułu."""
    match_id = request.args.get("m") or ""
    if not re.fullmatch(r"[A-Za-z0-9]{6,12}", match_id):
        return redirect(url_for("home"))
    article = (request.args.get("u") or "").strip()
    article = article if re.match(r"^https?://", article, re.I) and len(article) <= MAX_URL_LENGTH else ""
    sport = request.args.get("s") if request.args.get("s") in {p for p, _ in LIVE_SPORTS} else ""
    stub = {"href": f"{FLASHSCORE}mecz/{match_id}/", "home": "", "away": "", "score": "-", "extra": "", "status": "",
            "state": "", "sport": sport, "league": squash(request.args.get("l") or "")[:120]}
    try:
        board = flashscore_match(stub)
    except FetchError as err:
        return render_template("error.html", message=err.message, original=stub["href"], retry=request.full_path,
                               q=request.args.get("q", ""), rp=1), err.status
    try:
        stats = flashscore_stats(stub["href"])
    except FetchError:
        stats = []
    return render_template("board.html", score=board, stats=stats, article=article, match_id=match_id, sport=sport, q=request.args.get("q", ""),
                           rp=clamp_int(request.args.get("rp"), 1, 1, MAX_RESULT_PAGES), tick=int(time.time()) % 100000)


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
    started = time.monotonic()
    try:
        article = get_article(url)
    except VideoLink as found:
        return redirect(url_for("video", u=found.url, q=query or None, rp=results_page, a=1 if found.audio else None))
    except FetchError as err:
        resp = make_response(render_template("error.html", message=err.message, original=url, retry=request.full_path,
                                             blocked=err.blocked, **common), err.status)
        if err.blocked:  # następnym razem wyszukiwarka nie pokaże tej strony
            host, cookie = site_host(url), read_blocked_cookie()
            blocked_memory.set(host, True)
            if host not in cookie:
                cookie[host] = int(time.time() // 86400)
                resp.set_cookie(BLOCKED_COOKIE, encode_blocked_cookie(cookie), max_age=BLOCKED_DAYS * 86400, samesite="Lax")
        return resp
    pages = article["pages"]
    phrase = squash(request.args.get("s", ""))[:100]
    if phrase:  # szukanie na tej stronie
        hits, total = find_in_article(article, phrase)
        count = max(1, -(-len(hits) // FIND_PER_PAGE))
        find_page = clamp_int(request.args.get("sp"), 1, 1, count)
        return render_template(
            "find.html", title=article["title"], url=url, original=article["url"], host=host_of(article["url"]), s=phrase,
            fixed_url=url, hits=hits[(find_page - 1) * FIND_PER_PAGE:find_page * FIND_PER_PAGE], total=total,
            sp=find_page, pages=count, theme=article.get("theme"), images=images_enabled(), links=links_enabled(),
            has_images=False, has_links=False, bookmark_url=article["url"], bookmarked=is_bookmarked(article["url"]), **common,
        )
    page = min(page, len(pages))
    parts = urlparse(article["url"])
    videos = video_items(article)
    film = None
    chosen = clamp_int(request.args.get("wf"), 0, 0, len(videos))
    if chosen and page == 1:  # film przygotowywany w ramce z miniaturą, na tej samej stronie
        choices = AUDIO_CHOICES if videos[chosen - 1]["audio"] else VIDEO_CHOICES
        fmt = request.args.get("wfmt") if request.args.get("wfmt") in choices else choices[0]
        film = video_progress(videos[chosen - 1]["url"], article["url"], fmt,
                              clamp_int(request.args.get("wc"), 1, 1, VIDEO_MAX_PARTS), retry=bool(request.args.get("znowu")))
        film["index"] = chosen
    score = live_score(article) if page == 1 and not phrase else None
    verdict = None
    if film:
        if film["mode"] == "done":
            verdict = True
        elif film["mode"] == "error" and (film["status"] or {}).get("dead"):
            verdict = False
    shown = 0
    for number, video in enumerate(videos, 1):
        video["hide"] = number != chosen and dead_player(video["url"])  # wybrany zostaje – pokazuje swój komunikat
        if not video["hide"]:
            shown += 1
            video["n"] = shown
    resp = make_response(render_template(
        "read.html", title=article["title"], url=url, original=article["url"], host=host_of(article["url"]),
        items=page_items(pages[page - 1]), page=page, pages=len(pages), images=images_enabled(),
        has_images=any(b[0] in ("img", "gi", "thumb") or (b[0] == "ib" and '"img"' in b[1]) for p in pages for b in p),
        site=f"{parts.scheme}://{parts.netloc}",
        videos=videos, shown_videos=shown, film=film, score=score, rendered=article.get("rendered"), formats=VIDEO_FORMATS, theme=theme_cache.get(parts.hostname or "") or article.get("theme"),
        tick=int(time.time()) % 100000,
        links=links_enabled(), has_links=any(b[0] in ("pl", "ib") for p in pages for b in p),
        crumbs=article.get("crumbs") or [], site_name=article.get("site_name"), bookmark_url=article["url"],
        bookmarked=is_bookmarked(article["url"]), **common,
    ))
    resp.headers["Server-Timing"] = server_timing(article, time.monotonic() - started)
    cookie = read_blocked_cookie()
    if site_host(url) in cookie or blocked_memory.get(site_host(url)):  # strona znowu wpuszcza serwer
        blocked_memory.set(site_host(url), False)
        cookie.pop(site_host(url), None)
        resp.set_cookie(BLOCKED_COOKIE, encode_blocked_cookie(cookie), max_age=BLOCKED_DAYS * 86400, samesite="Lax")
    if verdict is not None:
        site = player_host(article["url"])
        sites = read_video_sites()
        if not any(h == site and ok == verdict for h, ok in sites[:1]) and (verdict or (site, True) not in sites):
            player_memory.set("s:" + site, verdict)  # strona, na której film kiedyś działał, nie staje się „martwa”
            resp.set_cookie(VIDEO_SITES_COOKIE, encode_video_sites([(site, verdict)] + [i for i in sites if i[0] != site]),
                            max_age=365 * 24 * 3600, samesite="Lax")
    return resp


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
                "p": poster or None, "fb": fallback or None, "a": request.args.get("a") or None}
        args.update(changes)
        return url_for("video", **args)

    poster_img = url_for("image", u=src, v=1, p=poster or None, f=fallback or None,
                         r=f"{site_url.scheme}://{site_url.netloc}") if images_enabled() else None
    theme = theme_cache.get(urlparse(referer).hostname or "") if referer else None
    theme = theme or theme_cache.get(urlparse(src).hostname or "")
    page = dict(src=src, referer=referer, title=title, host=host_of(src), part=part, formats=VIDEO_FORMATS, poster_img=poster_img,
                theme=theme, images=images_enabled(),
                first_minutes=part_length(0) // 60, link=link, status=None, part_total=None, has_next=False,
                next_ready=False, **common)
    os.makedirs(VIDEO_DIR, exist_ok=True)
    audio = request.args.get("a") == "1" or is_audio_url(src)
    choices = AUDIO_CHOICES if audio else VIDEO_CHOICES
    page["formats"] = {f: VIDEO_FORMATS[f] for f in choices}
    page["audio"] = audio
    if fmt not in choices and len(choices) == 1:
        fmt = choices[0]  # nagranie: jeden format – bez strony wyboru
    if fmt not in choices:
        ready = {f: (read_status(video_key(src, f, part - 1)) or {}).get("state") == "done" for f in choices}
        return render_template("film.html", mode="choose", ready=ready, **page)
    here = link(f=fmt, c=part)
    progress = video_progress(src, referer, fmt, part, retry=bool(request.args.get("znowu")))
    page.update(fmt=fmt, fmt_name=VIDEO_FORMATS[fmt]["name"], other=progress["other"], key=progress["key"], here=here,
                status=progress["status"], part_total=progress["part_total"], has_next=progress["has_next"],
                next_ready=progress["next_ready"])
    mode = progress["mode"]
    refresh = {"busy": 15, "work": 8}.get(mode)
    return render_template("film.html", mode=mode, refresh=refresh, **page)


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
        download_name=f"{'nagranie' if ext == 'mp3' else 'film'}-{key[:6]}.{ext}", max_age=VIDEO_KEEP_SECONDS,
    )


@app.route("/img")
def image():
    """Obrazek z artykułu zmniejszony dla telefonu. r = adres serwisu (Referer – część serwerów obrazków go wymaga)."""
    url = (request.args.get("u") or "").strip()
    referer = (request.args.get("r") or "").strip()
    thumb = request.args.get("t") == "1"  # miniatura ze strony z listą artykułów
    grid = request.args.get("t") == "2"  # obrazek w galerii (dwa obok siebie)
    hq = request.args.get("hq") == "1"  # powiększenie otwierane z czytnika
    if not re.match(r"^https?://", url, re.I) or len(url) > MAX_URL_LENGTH:
        return Response("", status=400)
    if request.args.get("v") == "1":
        return video_poster_response(url, referer)
    icon_bg = request.args.get("ic") or ""
    if re.fullmatch(r"[0-9a-fA-F]{6}", icon_bg):  # ikona serwisu w pasku: mała, na kolorze paska
        mode = "ic" + icon_bg.lower()
    else:
        icon_bg = ""
        mode = "hq" if hq else ("g" if grid else thumb)
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
            if icon_bg:
                color = tuple(int(icon_bg[i:i + 2], 16) for i in (0, 2, 4))
                data = shrink_image(read_body(resp, limit=1_000_000), 32, 32, 80, background=color, min_size=8)
            elif hq:
                data = shrink_image(read_body(resp, limit=IMAGE_HQ_MAX_BYTES), IMAGE_HQ_WIDTH, IMAGE_HQ_HEIGHT, IMAGE_HQ_QUALITY)
            else:
                size = (THUMB_MAX_SIZE, THUMB_MAX_SIZE) if thumb else GRID_IMAGE_SIZE if grid else (IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT)
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


# ---------- Zakładki (w ciasteczku telefonu – przetrwają restarty serwera) ----------
BOOKMARKS_COOKIE = "zakl"
BOOKMARKS_MAX = 40
BOOKMARKS_BYTES = 3600  # ciasteczko ma limit ok. 4 KB – najstarsze zakładki wypadają


def read_bookmarks():
    raw = request.cookies.get(BOOKMARKS_COOKIE) or ""
    try:
        data = json.loads(zlib.decompress(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))).decode("utf-8"))
    except (ValueError, zlib.error, TypeError):
        return []
    return [(u, t) for u, t in data if isinstance(u, str) and isinstance(t, str)][:BOOKMARKS_MAX] if isinstance(data, list) else []


def encode_bookmarks(items):
    items = items[:BOOKMARKS_MAX]
    while True:
        raw = base64.urlsafe_b64encode(zlib.compress(json.dumps(items, ensure_ascii=False).encode("utf-8"), 9)).decode().rstrip("=")
        if len(raw) <= BOOKMARKS_BYTES or not items:
            return raw
        items = items[:-1]


def is_bookmarked(url):
    return any(u == url for u, _ in read_bookmarks())


@app.route("/zakladki")
def bookmarks():
    return render_template("bookmarks.html", items=read_bookmarks(), q="")


@app.route("/zakladki/dodaj")
def bookmark_add():
    url, title = (request.args.get("u") or "").strip(), shorten(squash(request.args.get("t") or ""), 70)
    resp = redirect(safe_next(request.args.get("next")))
    if re.match(r"^https?://", url, re.I) and len(url) <= 600:
        items = [(url, title or host_of(url))] + [(u, t) for u, t in read_bookmarks() if u != url]
        resp.set_cookie(BOOKMARKS_COOKIE, encode_bookmarks(items), max_age=5 * 365 * 24 * 3600, samesite="Lax")
    return resp


@app.route("/zakladki/usun")
def bookmark_remove():
    url = (request.args.get("u") or "").strip()
    resp = redirect(safe_next(request.args.get("next")))
    resp.set_cookie(BOOKMARKS_COOKIE, encode_bookmarks([(u, t) for u, t in read_bookmarks() if u != url]),
                    max_age=5 * 365 * 24 * 3600, samesite="Lax")
    return resp


# ---------- Pogoda (Open-Meteo, zapasowo wttr.in) i kursy walut (NBP) – bez kluczy API ----------
DEFAULT_CITY = "Warszawa"
WEATHER_CODES = {
    0: "bezchmurnie", 1: "przeważnie pogodnie", 2: "częściowe zachmurzenie", 3: "pochmurno", 45: "mgła", 48: "mgła z szadzią",
    51: "lekka mżawka", 53: "mżawka", 55: "gęsta mżawka", 56: "marznąca mżawka", 57: "marznąca mżawka", 61: "słaby deszcz",
    63: "deszcz", 65: "ulewa", 66: "marznący deszcz", 67: "marznący deszcz", 71: "słaby śnieg", 73: "śnieg",
    75: "intensywny śnieg", 77: "ziarnisty śnieg", 80: "przelotny deszcz", 81: "przelotny deszcz", 82: "gwałtowna ulewa",
    85: "przelotny śnieg", 86: "przelotny śnieg", 95: "burza", 96: "burza z gradem", 99: "burza z gradem",
}
WTTR_CODES = {  # kody pogody wttr.in (WWO) – jego prognoza godzinowa nie ma opisów po polsku
    113: "bezchmurnie", 116: "częściowe zachmurzenie", 119: "pochmurno", 122: "całkowite zachmurzenie", 143: "zamglenie",
    176: "miejscami przelotny deszcz", 179: "miejscami śnieg", 182: "miejscami deszcz ze śniegiem",
    185: "miejscami marznąca mżawka", 200: "miejscami burze", 227: "zamieć śnieżna", 230: "zamieć", 248: "mgła",
    260: "marznąca mgła", 263: "miejscami mżawka", 266: "mżawka", 281: "marznąca mżawka", 284: "silna marznąca mżawka",
    293: "miejscami słaby deszcz", 296: "słaby deszcz", 299: "okresami deszcz", 302: "deszcz", 305: "okresami ulewa",
    308: "ulewa", 311: "słaby marznący deszcz", 314: "marznący deszcz", 317: "słaby deszcz ze śniegiem",
    320: "deszcz ze śniegiem", 323: "miejscami słaby śnieg", 326: "słaby śnieg", 329: "miejscami śnieg", 332: "śnieg",
    335: "miejscami intensywny śnieg", 338: "intensywny śnieg", 350: "grad", 353: "przelotny słaby deszcz",
    356: "przelotny deszcz", 359: "przelotna ulewa", 362: "przelotny deszcz ze śniegiem", 365: "przelotny deszcz ze śniegiem",
    368: "przelotny słaby śnieg", 371: "przelotny śnieg", 374: "przelotny grad", 377: "przelotny grad",
    386: "burza z deszczem", 389: "burza z ulewą", 392: "burza ze śniegiem", 395: "burza śnieżna",
}
CURRENCIES = ("EUR", "USD", "GBP", "CHF")
DAY_NAMES = ("pon.", "wt.", "śr.", "czw.", "pt.", "sob.", "niedz.")
weather_cache = DiskCache("pogoda", ttl=1800, max_files=200)
places_cache = DiskCache("miejsca", ttl=30 * 24 * 3600, max_files=500)
rates_cache = DiskCache("kursy", ttl=3 * 3600, max_files=5)


def user_city():
    return squash(unquote(request.cookies.get("miasto") or ""))[:60] or DEFAULT_CITY


def day_label(date_text, index):
    if index == 0:
        return "dziś"
    if index == 1:
        return "jutro"
    try:
        return DAY_NAMES[time.strptime(date_text, "%Y-%m-%d").tm_wday]
    except ValueError:
        return date_text


def fetch_weather(city):
    """{"city", "temp", "desc", "days": [{"label", "min", "max", "desc"}]} albo None (gdy miasto nieznane)."""
    key = fold(city)
    cached = weather_cache.get(key)
    if cached is not None:
        return cached or None
    weather = None
    try:
        place = places_cache.get(key)
        if place is None:
            found = read_json("https://geocoding-api.open-meteo.com/v1/search?count=1&language=pl&format=json&name="
                              + quote(city)).get("results") or []
            place = found[0] if found else {}
            places_cache.set(key, place)
        if place:
            data = read_json(f"https://api.open-meteo.com/v1/forecast?latitude={place['latitude']}&longitude={place['longitude']}"
                             "&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code"
                             "&timezone=auto&forecast_days=4")
            daily = data["daily"]
            weather = {
                "city": place.get("name") or city, "temp": round(data["current"]["temperature_2m"]),
                "desc": WEATHER_CODES.get(data["current"]["weather_code"], ""),
                "days": [{"label": day_label(d, i), "min": round(lo), "max": round(hi), "desc": WEATHER_CODES.get(c, "")}
                         for i, (d, lo, hi, c) in enumerate(zip(daily["time"], daily["temperature_2m_min"],
                                                                daily["temperature_2m_max"], daily["weather_code"]))],
            }
    except (FetchError, KeyError, TypeError, IndexError):
        weather = None
    if weather is None:
        weather = fetch_weather_wttr(city)
    weather_cache.set(key, weather or {})
    return weather


def fetch_weather_wttr(city):
    """Zapasowe źródło: wttr.in (opisy po polsku)."""
    try:
        data = read_json("https://wttr.in/" + quote(city) + "?format=j1&lang=pl")
        now = data["current_condition"][0]
        def desc(item):
            code = int(item.get("weatherCode") or 0)
            return WTTR_CODES.get(code) or ((item.get("lang_pl") or item.get("weatherDesc") or [{}])[0].get("value") or "").lower()
        return {
            "city": city, "temp": int(now["temp_C"]), "desc": desc(now),
            "days": [{"label": day_label(day["date"], i), "min": int(day["mintempC"]), "max": int(day["maxtempC"]),
                      "desc": desc(day["hourly"][min(4, len(day["hourly"]) - 1)])} for i, day in enumerate(data["weather"][:4])],
        }
    except (FetchError, KeyError, TypeError, IndexError, ValueError):
        return None


def fetch_rates():
    """Średnie kursy NBP (tabela A): {"date", "rates": [(kod, kurs)]} albo None."""
    cached = rates_cache.get("A")
    if cached is not None:
        return cached or None
    try:
        table = read_json("https://api.nbp.pl/api/exchangerates/tables/A/?format=json")[0]
        mids = {r["code"]: r["mid"] for r in table["rates"]}
        rates = {"date": table["effectiveDate"], "rates": [(c, f"{mids[c]:.2f}".replace(".", ",")) for c in CURRENCIES if c in mids]}
    except (FetchError, KeyError, TypeError, IndexError, ValueError):
        rates = None
    rates_cache.set("A", rates or {})
    return rates


def home_widgets(city, wait=2.0):
    """Pogoda i kursy na stronę główną – pobierane równolegle; strona nie czeka dłużej niż `wait` sekund
    (co nie zdąży, pokaże się przy następnym wejściu, bo wynik i tak trafi do pamięci podręcznej)."""
    result = {}

    def load(name, function, *args):
        result[name] = function(*args)

    threads = [threading.Thread(target=load, args=("weather", fetch_weather, city), daemon=True),
               threading.Thread(target=load, args=("rates", fetch_rates), daemon=True)]
    for thread in threads:
        thread.start()
    deadline = time.monotonic() + wait
    for thread in threads:
        thread.join(timeout=max(0.0, deadline - time.monotonic()))
    return result.get("weather"), result.get("rates")


@app.route("/pogoda")
def weather_page():
    city = squash(request.args.get("miasto") or "")[:60]
    resp_city = city or user_city()
    weather, rates = home_widgets(resp_city, wait=8.0)
    body = render_template("weather.html", weather=weather, rates=rates, city=resp_city, q="")
    resp = app.make_response(body)
    if city:
        resp.set_cookie("miasto", quote(city), max_age=365 * 24 * 3600, samesite="Lax")  # zakodowane: polskie litery
    return resp


@app.route("/ustaw")
def settings():
    """Zmienia ustawienie (zapamiętane w telefonie na rok) i wraca na tę samą stronę."""
    key, value = request.args.get("k") or "", (request.args.get("v") or "").strip()
    resp = redirect(safe_next(request.args.get("next")))
    if key in SETTINGS and (value in SETTINGS[key] if SETTINGS[key] else 0 < len(value) <= 60):
        resp.set_cookie(key, value, max_age=365 * 24 * 3600, samesite="Lax")
    return resp


@app.context_processor
def page_settings():
    return {"text_css": text_css(), "saving": saving_enabled(), "data_mb": data_used() / 1_000_000,
            "text_size": request.cookies.get("tekst") or "m"}


@app.after_request
def count_data(resp):
    """Licznik danych w ciasteczku („RRRRMM:bajty”): każda strona, obrazek i plik wysłany przez Szukajkę.
    Przybliżony – Opera Mini dodatkowo kompresuje strony, a równoległe pobrania obrazków mogą się nadpisać."""
    if request.endpoint in (None, "healthz", "robots", "icon", "diag") or resp.status_code >= 400:
        return resp
    size = resp.content_length or resp.calculate_content_length() or 0
    if size:
        resp.set_cookie(DATA_COOKIE, f"{time.strftime('%Y%m')}:{data_used() + size}", max_age=40 * 24 * 3600, samesite="Lax")
        if "public" in (resp.headers.get("Cache-Control") or ""):
            resp.headers["Cache-Control"] = resp.headers["Cache-Control"].replace("public", "private")
    return resp


@app.route("/linki")
def toggle_links():
    """Włącza/wyłącza linki w tekście akapitów (na klawiaturze każdy link to dodatkowy przystanek strzałki)."""
    target = request.args.get("next") or "/"
    if not target.startswith("/") or target.startswith("//"):
        target = "/"
    resp = redirect(target)
    resp.set_cookie("linki", "0" if request.args.get("wl") == "0" else "1", max_age=365 * 24 * 3600, samesite="Lax")
    return resp


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
    state = cf_state()
    lines.append("Cloudflare (strony z JavaScriptem): " + (
        "brak kluczy CF_ACCOUNT_ID / CF_API_TOKEN" if not (CF_ACCOUNT_ID and CF_API_TOKEN) else
        f"wstrzymane do {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime(state['down_until']))} – {state.get('reason')}"
        if time.time() < state.get("down_until", 0) else "skonfigurowane"))
    if request.args.get("cf") and CF_ACCOUNT_ID and CF_API_TOKEN:  # /diag?cf=1 – jedno zapytanie próbne
        started = time.monotonic()
        resp = cf_content({"url": "https://example.com/", "rejectResourceTypes": ["image", "media", "font", "stylesheet"]})
        took = int((time.monotonic() - started) * 1000)
        if resp is None:
            lines.append(f"Cloudflare test: brak połączenia ({took} ms)")
        else:
            ok = resp.status_code == 200 and "Example Domain" in resp.text
            lines.append(f"Cloudflare test: HTTP {resp.status_code}, {'DZIAŁA' if ok else cf_error(resp)}, {took} ms, "
                         f"konto {CF_ACCOUNT_ID[:4]}…{CF_ACCOUNT_ID[-4:]} ({len(CF_ACCOUNT_ID)} znaków), "
                         f"token {len(CF_API_TOKEN)} znaków")
            if ok:
                cf_state({"down_until": 0, "reason": ""})
        for where in (f"accounts/{CF_ACCOUNT_ID}", "user"):  # czy Cloudflare zna sam token (konta i użytkownika)
            try:
                check = requests.get(f"https://api.cloudflare.com/client/v4/{where}/tokens/verify", timeout=(5, 10),
                                     headers={"Authorization": f"Bearer {CF_API_TOKEN}"})
                status = (check.json().get("result") or {}).get("status") if check.status_code == 200 else None
                lines.append(f"Cloudflare token ({where.split('/')[0]}): HTTP {check.status_code}, "
                             f"{status or cf_error(check)}")
            except (requests.exceptions.RequestException, ValueError) as err:
                lines.append(f"Cloudflare token ({where.split('/')[0]}): błąd {type(err).__name__}")
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
