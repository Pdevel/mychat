"""Ultralekka wyszukiwarka i czytnik stron dla Opera Mini na telefonach z klawiaturą
(Nokia 235 4G / Nokia 3210 4G: ekran 2,8", brak dotyku, 64 MB RAM).

Strony to czysty HTML: bez CSS, bez JavaScriptu, z jak najmniejszą liczbą linków przed treścią,
żeby wygodnie przechodzić po nich samymi strzałkami.

  /        – formularz wyszukiwania
  /search  – wyniki z DuckDuckGo Lite (region polski), 10 na stronę. Gdy DuckDuckGo blokuje serwer (np. na Render.com),
             wyniki przychodzą przez FrogFind (frogfind.com – prosta nakładka na DuckDuckGo, bez klucza API);
             opcjonalnie jeszcze Brave Search API (klucz w zmiennej BRAVE_API_KEY)
  /read    – czytnik: pobiera stronę, zostawia sam tekst (tytuł, nagłówki, akapity) i dzieli go na strony
"""

import io
import ipaddress
import json
import logging
import os
import re
import socket
import threading
import time
from collections import OrderedDict
from urllib.parse import parse_qs, urljoin, urlparse

import requests
import urllib3.util.connection as urllib3_connection
from bs4 import BeautifulSoup
from flask import Flask, Response, redirect, render_template, request, url_for
from jinja2 import DictLoader
from PIL import Image, ImageOps

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
IMAGE_MIN_SIZE = 48  # mniejsze to ikonki, flagi i piksele śledzące – na ekranie 240 px to tylko szum
IMAGES_PER_ARTICLE = 12  # więcej obrazków to zbyt dużo danych i pracy dla telefonu i darmowego serwera
IMAGE_WEIGHT = 600  # obrazek zajmuje na stronie czytnika tyle „znaków” z limitu ARTICLE_PAGE_CHARS
# Miniatury na stronach z listą artykułów (np. główna serwisu): mniejsze i lżejsze niż zdjęcia w artykule.
THUMB_MAX_SIZE = int(os.environ.get("THUMB_MAX_SIZE", "120"))  # najdłuższy bok miniatury w px
THUMBS_PER_LISTING = 30
THUMB_WEIGHT = 300  # ok. 10 miniatur na jedną stronę czytnika
Image.MAX_IMAGE_PIXELS = 25_000_000  # ochrona przed „bombami” (ogromne wymiary w małym pliku)

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

    def __init__(self, message, status=502):
        super().__init__(message)
        self.message = message
        self.status = status


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


def collect_blocks(root, base_url, with_images=False, skip_images=frozenset(), image_kind="img", max_images=IMAGES_PER_ARTICLE):
    """Zbiera z drzewa nagłówki i akapity w kolejności występowania, bez powtarzania zagnieżdżonych.
    Blok to (rodzaj, tekst, adres_linku_lub_None); ten sam adres linkujemy tylko raz.
    Z with_images=True dochodzą bloki (image_kind, opis, adres_obrazka) – najwyżej max_images
    ("img" – zdjęcie w artykule, "thumb" – miniatura na stronie z listą)."""
    blocks, linked, images = [], set(), set()
    for node in root.find_all(BLOCK_TAGS + (["img"] if with_images else [])):
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


def fallback_blocks(soup, base_url, skip_images=frozenset()):
    """Gdy readability zawiedzie: usuń śmieci (skrypty, menu, reklamy…) i weź tekst z <article>/<main>/<body>."""
    for tag in soup(JUNK_TAGS):
        tag.decompose()
    for tag in soup.find_all(True):
        if tag.attrs is None:
            continue
        hint = " ".join(tag.get("class") or []) + " " + (tag.get("id") or "")
        if hint.strip() and JUNK_HINT.search(hint) and tag.name not in ("body", "html", "article", "main"):
            tag.decompose()
    root = soup.find("article") or soup.find("main") or soup.body or soup
    blocks = collect_blocks(
        root, base_url, with_images=True, skip_images=skip_images, image_kind="thumb", max_images=THUMBS_PER_LISTING
    )
    if not [b for b in blocks if b[0] != "thumb"]:  # strona bez akapitów – bierzemy linie tekstu
        blocks = [("p", line, None) for line in (squash(x) for x in root.get_text("\n").split("\n")) if len(line) > 1]
    return blocks


CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")  # przez nie readability (lxml) odmawia pracy


def extract_article(html, url):
    """Zwraca (tytuł, bloki), gdzie blok to ("h" | "p", tekst, adres_linku_lub_None)."""
    html = CONTROL_CHARS.sub("", html)
    soup = BeautifulSoup(html, "lxml")
    title = node_text(soup.title) or host_of(url)
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
    if readability_chars < 1500:
        fallback = fallback_blocks(soup, url, skip_images=small_images)
        if sum(len(b[1]) for b in fallback if b[0] != "thumb") > readability_chars:
            blocks = fallback
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
        raise FetchError(f"Strona zwróciła błąd {resp.status_code}.", 502)
    content_type = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
    if content_type and not (content_type.startswith("text/") or "html" in content_type or "xml" in content_type):
        resp.close()
        raise FetchError("To nie jest strona z tekstem (np. PDF albo obrazek). Otwórz [Oryginał].", 415)
    text = decode_html(read_body(resp), resp)
    if content_type == "text/plain":
        title = host_of(final_url)
        blocks = [("p", squash(part), None) for part in re.split(r"\n\s*\n", text) if squash(part)]
    else:
        title, blocks = extract_article(text, final_url)
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
    article = {"title": title, "url": final_url, "pages": paginate(kept, ARTICLE_PAGE_CHARS)}
    article_cache.set(url, article)
    return article


# ---------- Obrazki dopasowane do telefonu ----------
def shrink_image(raw, max_width=IMAGE_MAX_WIDTH, max_height=IMAGE_MAX_HEIGHT):
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
            image.save(out, "JPEG", quality=IMAGE_QUALITY, optimize=True, progressive=False)  # zwykły JPEG – najlżejszy do dekodowania
            return out.getvalue()
    except (OSError, ValueError, Image.DecompressionBombError) as err:
        log.info("nie da się przetworzyć obrazka: %s", str(err)[:120])
        return None


def images_enabled():
    return request.cookies.get("obrazki") != "0"


# ---------- Szablony (czysty HTML: bez CSS i JavaScriptu) ----------
TEMPLATES = {
    "base.html": """<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>{% block title %}Szukaj{% endblock %}</title>
</head>
<body>
{% block body %}{% endblock %}
</body>
</html>
""",
    "_form.html": """<form action="{{ url_for('search') }}" method="get">
<input type="text" name="q" value="{{ q or '' }}" size="16" maxlength="200">
<input type="submit" value="Szukaj">
</form>
""",
    "_nav.html": """<p>{% if q %}<a href="{{ url_for('search', q=q, p=rp) }}">Wróć do wyników</a> | {% endif %}<a href="{{ url_for('home') }}">Nowe szukanie</a></p>
""",
    "home.html": """{% extends "base.html" %}
{% block body %}{% include "_form.html" %}
<p>Szukaj w sieci i czytaj strony w lekkiej wersji tekstowej.</p>
{% endblock %}
""",
    "search.html": """{% extends "base.html" %}
{% block title %}{{ q }} - szukaj{% endblock %}
{% block body %}<b>{{ q }}</b>{% if page > 1 %} (str. {{ page }}){% endif %}
{% if error %}<p>{{ error }}</p>{% endif %}
{% for r in results %}<p>{{ offset + loop.index }}. <a href="{{ url_for('read', url=r.url, q=q, rp=page) }}">{{ r.title }}</a><br>
{% if r.snippet %}{{ r.snippet }}<br>{% endif %}<small>{{ r.host }}</small> <a href="{{ r.url }}">[Oryginał]</a></p>
{% endfor %}{% if not results and not error %}<p>Brak wyników.</p>
{% endif %}<p>{% if has_more %}<a href="{{ url_for('search', q=q, p=page + 1) }}">Następna strona &raquo;</a><br>{% endif %}
{% if page > 1 %}<a href="{{ url_for('search', q=q, p=page - 1) }}">&laquo; Poprzednia strona</a>{% endif %}</p>
{% include "_form.html" %}
{% endblock %}
""",
    "read.html": """{% extends "base.html" %}
{% block title %}{{ title }}{% endblock %}
{% block body %}{% include "_nav.html" %}
<h2>{{ title }}</h2>
{% if pages > 1 %}<p>Strona {{ page }} z {{ pages }}</p>
{% endif %}{% for kind, text, href in blocks %}{% if kind in ("img", "thumb") %}{% if images %}<p><img src="{{ url_for('image', u=href, r=site, t=1 if kind == 'thumb' else None) }}" alt="{{ text or 'obrazek' }}"></p>
{% endif %}{% elif href %}{% set link %}<a href="{{ url_for('read', url=href, q=q, rp=rp) }}">{{ text }}</a>{% endset %}{% else %}{% set link = text %}{% endif %}{% if kind == "h" %}<h3>{{ link }}</h3>
{% else %}<p>{{ link }}</p>
{% endif %}{% endfor %}<p>{% if page < pages %}<a href="{{ url_for('read', url=url, q=q, rp=rp, page=page + 1) }}">Dalej &raquo;</a> ({{ page }}/{{ pages }})<br>{% endif %}
{% if page > 1 %}<a href="{{ url_for('read', url=url, q=q, rp=rp, page=page - 1) }}">&laquo; Wstecz</a>{% endif %}</p>
{% include "_nav.html" %}<p><a href="{{ original }}">[Oryginał]</a>{% if has_images %}<br><a href="{{ url_for('toggle_images', wl=0 if images else 1, next=request.full_path) }}">Obrazki: {{ "wyłącz" if images else "włącz" }}</a>{% endif %}</p>
{% endblock %}
""",
    "error.html": """{% extends "base.html" %}
{% block title %}Błąd{% endblock %}
{% block body %}{% include "_nav.html" %}
<p>{{ message }}</p>
{% if original %}<p><a href="{{ retry }}">Spróbuj ponownie</a><br><a href="{{ original }}">[Oryginał]</a></p>{% endif %}
{% endblock %}
""",
}

app = Flask(__name__)
app.jinja_loader = DictLoader(TEMPLATES)


@app.route("/")
def home():
    return render_template("home.html", q="")


@app.route("/search")
def search():
    query = squash(request.args.get("q", ""))[:200]
    if not query:
        return redirect(url_for("home"))
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
    except FetchError as err:
        return render_template("error.html", message=err.message, original=url, retry=request.full_path, **common), err.status
    pages = article["pages"]
    page = min(page, len(pages))
    parts = urlparse(article["url"])
    return render_template(
        "read.html", title=article["title"], url=url, original=article["url"],
        blocks=pages[page - 1], page=page, pages=len(pages), images=images_enabled(),
        has_images=any(b[0] in ("img", "thumb") for p in pages for b in p), site=f"{parts.scheme}://{parts.netloc}", **common,
    )


@app.route("/img")
def image():
    """Obrazek z artykułu zmniejszony dla telefonu. r = adres serwisu (Referer – część serwerów obrazków go wymaga)."""
    url = (request.args.get("u") or "").strip()
    referer = (request.args.get("r") or "").strip()
    thumb = request.args.get("t") == "1"  # miniatura ze strony z listą artykułów
    if not re.match(r"^https?://", url, re.I) or len(url) > MAX_URL_LENGTH:
        return Response("", status=400)
    data = image_cache.get((url, thumb))
    if data is None:
        headers = {"Accept": "image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8"}
        if re.match(r"^https?://[^/\s]+$", referer):
            headers["Referer"] = referer + "/"
        try:
            _, resp = http_request(url, extra_headers=headers)
            if resp.status_code >= 400 or not resp.headers.get("Content-Type", "").lower().startswith("image/"):
                resp.close()
                return Response("", status=404)
            size = (THUMB_MAX_SIZE, THUMB_MAX_SIZE) if thumb else (IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT)
            data = shrink_image(read_body(resp, limit=IMAGE_MAX_BYTES), *size)
        except FetchError as err:
            return Response("", status=err.status)
        if data is None:
            return Response("", status=404)
        image_cache.set((url, thumb), data)
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
