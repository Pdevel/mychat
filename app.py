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


def parse_frogfind(html):
    """Wyniki z frogfind.com: <a href=…><b>tytuł</b>…</a>, za nim opis aż do <hr>.

    Link bywa w trzech postaciach: /read.php?a=ADRES (czytnik FrogFind), //duckduckgo.com/l/?uddg=ADRES
    albo po prostu bezpośredni adres – FrogFind przepisuje tylko stary format linków DuckDuckGo.
    """
    soup = BeautifulSoup(html, "lxml")
    results = []
    for link in soup.find_all("a", href=True):
        href = link["href"].strip()
        if "read.php?a=" in href:
            href = (parse_qs(urlparse(href).query).get("a") or [""])[0]
        url = clean_result_url(href)  # odrzuca też linki wewnętrzne FrogFind (np. logo „/”) i reklamy DuckDuckGo
        if not url or link.find(["b", "font"]) is None:
            continue
        bold = link.find("b")
        title = node_text(bold) or node_text(link) or url
        parts = []
        for sibling in link.next_siblings:
            if getattr(sibling, "name", None) in ("hr", "a"):
                break
            parts.append(sibling.get_text() if hasattr(sibling, "get_text") else str(sibling))
        results.append({"title": title, "url": url, "snippet": shorten(squash("".join(parts)), SNIPPET_CHARS)})
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
        log.warning("FrogFind: 0 wyników (%d B, linków read.php: %d): %s", len(html), html.count("read.php?a="),
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
    "script", "style", "noscript", "template", "iframe", "object", "embed", "svg", "canvas", "img",
    "picture", "video", "audio", "source", "figure", "form", "button", "input", "select", "textarea",
    "nav", "header", "footer", "aside", "menu", "dialog",
]
JUNK_HINT = re.compile(
    r"(^|[-_ ])(nav|menu|footer|header|sidebar|cookie|consent|banner|advert|ads?|promo|social|share|"
    r"related|newsletter|comment|popup|modal|breadcrumb)([-_ ]|$)",
    re.I,
)


def collect_blocks(root):
    """Zbiera z drzewa nagłówki i akapity w kolejności występowania, bez powtarzania zagnieżdżonych."""
    blocks = []
    for node in root.find_all(BLOCK_TAGS):
        if any(parent.name in CONTAINER_TAGS for parent in node.parents):
            continue  # np. <p> wewnątrz <li> – tekst trafi już z rodzica
        text = node_text(node)
        if not text:
            continue
        if node.name in ("h1", "h2", "h3", "h4", "h5", "h6"):
            blocks.append(("h", text))
        elif node.name == "li":
            blocks.append(("p", "• " + text))
        else:
            blocks.append(("p", text))
    return blocks


def fallback_blocks(soup):
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
    blocks = collect_blocks(root)
    if not blocks:  # strona bez akapitów – bierzemy linie tekstu
        blocks = [("p", line) for line in (squash(x) for x in root.get_text("\n").split("\n")) if len(line) > 1]
    return blocks


def extract_article(html, url):
    """Zwraca (tytuł, bloki), gdzie blok to ("h" | "p", tekst)."""
    soup = BeautifulSoup(html, "lxml")
    title = node_text(soup.title) or host_of(url)
    blocks = []
    if Document is not None:
        try:
            doc = Document(html, url=url)
            title = squash(doc.short_title()) or title
            blocks = collect_blocks(BeautifulSoup(doc.summary(html_partial=True), "lxml"))
        except Exception:
            blocks = []
    if sum(len(text) for _, text in blocks) < 300:
        fallback = fallback_blocks(soup)
        if sum(len(t) for _, t in fallback) > sum(len(t) for _, t in blocks):
            blocks = fallback
    if blocks and blocks[0][0] == "h" and blocks[0][1] == title:
        blocks = blocks[1:]  # tytuł pokazujemy osobno
    return title, blocks


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
    for kind, text in blocks:
        for piece in split_long(text, budget):
            if size and size + len(piece) > budget:
                carry = [pages[-1].pop()] if pages[-1] and pages[-1][-1][0] == "h" else []
                pages.append(carry)
                size = sum(len(t) for _, t in carry)
            pages[-1].append((kind, piece))
            size += len(piece)
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
        blocks = [("p", squash(part)) for part in re.split(r"\n\s*\n", text) if squash(part)]
    else:
        title, blocks = extract_article(text, final_url)
    if not blocks:
        raise FetchError("Nie udało się wydobyć tekstu z tej strony. Otwórz [Oryginał].", 422)
    truncated, total, kept = False, 0, []
    for block in blocks:
        total += len(block[1])
        if total > ARTICLE_MAX_CHARS:
            truncated = True
            break
        kept.append(block)
    if truncated:
        kept.append(("p", "[Artykuł skrócony – całość w oryginale.]"))
    article = {"title": title, "url": final_url, "pages": paginate(kept, ARTICLE_PAGE_CHARS)}
    article_cache.set(url, article)
    return article


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
{% endif %}{% for kind, text in blocks %}{% if kind == "h" %}<h3>{{ text }}</h3>
{% else %}<p>{{ text }}</p>
{% endif %}{% endfor %}<p>{% if page < pages %}<a href="{{ url_for('read', url=url, q=q, rp=rp, page=page + 1) }}">Dalej &raquo;</a> ({{ page }}/{{ pages }})<br>{% endif %}
{% if page > 1 %}<a href="{{ url_for('read', url=url, q=q, rp=rp, page=page - 1) }}">&laquo; Wstecz</a>{% endif %}</p>
{% include "_nav.html" %}<p><a href="{{ original }}">[Oryginał]</a></p>
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
    return render_template(
        "read.html", title=article["title"], url=url, original=article["url"],
        blocks=pages[page - 1], page=page, pages=len(pages), **common,
    )


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
        lines.append(f"frogfind 'wikipedia': HTTP {resp.status_code}, {len(body)} B, linków read.php: "
                     f"{body.count('read.php?a=')}, wyników odczytanych: {len(parse_frogfind(body))}, "
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
