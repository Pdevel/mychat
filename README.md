# Lekka szukajka

Wyszukiwarka i czytnik stron dla Opera Mini na telefonach z klawiaturą (Nokia 235 4G, Nokia 3210 4G).
Prosty HTML bez JavaScriptu i bez plików CSS (tylko mały wbudowany `<style>`, ok. 1 KB, bez flex/grid),
nawigacja samymi strzałkami.

- `/` – strona główna: ciemna, duże logo, zaokrąglone pole wyszukiwania z lupą; „+” prowadzi do `/link`
- `/link` – „Masz dokładny link?”: otwarcie konkretnej strony albo szukanie słowa tylko na niej
- `/search?q=…` – wyniki z DuckDuckGo Lite (region polski), 10 na stronę, z linkiem [Oryginał]; wpisany link
  (np. `rp.pl`, `www.onet.pl`, `https://…`) otwiera stronę od razu
- `/read?url=…` – czytnik: sam tekst strony (tytuł, nagłówki, akapity), podzielony na strony po ok. 3000 znaków
- `/read?url=…&s=słowo` – szukanie na konkretnej stronie: fragmenty z tym słowem (bez względu na wielkość liter
  i polskie znaki) z odnośnikiem do miejsca w tekście; formularz „Masz dokładny link?” na stronie głównej i na dole czytnika
- `/img?u=…` – obrazki z artykułów zmniejszone dla telefonu (szczegóły niżej)
- `/film?u=…` – filmy ze stron przekodowane dla telefonu (szczegóły niżej)

## Układ artykułu jak na oryginale

- nazwa serwisu (`og:site_name`) pod tytułem i ścieżka nawigacji („Strona główna / Kategoria”) nad tytułem – widoczna na
  stronie, a gdy jej brak, z JSON-LD `BreadcrumbList`,
- karta danych jak na stronie: wiersze „Etykieta : wartości” (np. Autor, Kategoria, Tagi) zebrane w ramce pod zdjęciem
  głównym, z linkami; bez „Zobacz też”, polecanych, nagłówka i stopki strony,
- tytuł z nagłówka strony (`<h1>`), bez dopisku serwisu („Polska”, a nie „Polska – Wikipedia, wolna encyklopedia”),
- linki w tekście akapitów (przez czytnik); na dole przełącznik „Linki w tekście: wyłącz/włącz” – na klawiaturze każdy
  link to dodatkowy przystanek strzałki,
- tabela informacyjna (infobox, także Fandom) jako ramka zaraz po pierwszym akapicie, jak w mobilnej Wikipedii: tytuł,
  zdjęcia z podpisami (herb i flaga obok siebie, powiększenie po wybraniu), „Etykieta: wartość” z linkami, wiersze
  rozdzielone `<br>` (np. populacja: liczba ludności, gęstość) jako osobne pozycje; pokazywana także w krótkich hasłach,
- bez znaczników przypisów („[1]”, „[a]”), linków „edytuj”, szablonów nawigacyjnych i spisów treści,
- odstępy jak w przeglądarce (bez „Polska , Rzeczpospolita”).

## Wygląd jak na oryginalnej stronie

Każda strona w czytniku dostaje barwy swojego serwisu: kolor marki na pasku (z `<meta name="theme-color">` albo z CSS:
zmienne `--primary`/`--brand`…, kolor linków, najczęstszy wyrazisty kolor), jasne albo ciemne tło (z reguł `html`/`body`
pasujących do klas strony, także przez `var(--…)`, albo z oznaczeń trybu ciemnego) i ikonę serwisu w pasku. Kontrast
jest pilnowany (tekst i linki czytelne na małym ekranie). Serwer czyta do 4 arkuszy CSS strony, równolegle i z pamięcią
podręczną (doba). To nadal mały wbudowany blok `<style>` – bez plików CSS i JavaScriptu.

## Strony z listą (strony główne, sklepy, katalogi)

Strona główna serwisu i strony z małą ilością tekstu są pokazywane jako lista: każdy tytuł to link, obok miniatura.
Czytnik rozpoznaje też siatki „kafelków” – link z obrazkiem i tytułem w zwykłym `<div>`/`<span>`, w `title` albo
`alt`, kafelki w osobnych `<article>` i w `<li>` (np. tytuł · cena). Menu nieoznaczone jako `<nav>` (ciąg krótkich
linków) jest pomijane, żeby nie przewijać dziesiątek pozycji przed treścią.
Listy, które strona wyświetla dopiero JavaScriptem, czytnik bierze z danych wbudowanych w HTML (`__NEXT_DATA__`
z Next.js, inne `<script type="application/json">`, JSON-LD `ItemList`): obiekty z tytułem, adresem i obrazkiem.
Menu i stopki z tych danych (krótkie tytuły bez obrazków) są pomijane.

## Zgodność ze sprzętem (Nokia 3210 4G / 235 4G: UNISOC T107, 64 MB RAM, 128 MB pamięci, ekran 240×320)

| | Szukajka | Uwagi |
|---|---|---|
| strona (HTML) | 3–7 KB, po kompresji 1–3 KB | bez JavaScriptu i plików CSS |
| obrazki na stronie | 4–12 KB razem, najwyżej ok. 0,2 MB w pamięci | 220 px, zwykły JPEG |
| powiększenie zdjęcia | do 480×2000 px, ≤ 3,8 MB w pamięci | tylko po wybraniu zdjęcia |
| film MP4 | H.264 Baseline 1.3, do 320×240, 15 kl./s, AAC mono 22 kHz | ok. 1,1 MB na minutę |
| film 3GP | H.263 176×144, AMR 8 kHz | ok. 1 MB na minutę |
| część filmu | 3, 6, 12, potem 15 min – ok. 3,5 / 7 / 14 / 17 MB | dłuższe filmy lepiej zapisywać na kartę microSD |

## Obrazki dla Nokii 235 4G / 3210 4G

Serwer pobiera obrazek, zmniejsza go do 220 px szerokości (ekran ma 240 px), zapisuje jako zwykły JPEG
(jakość 45, bez metadanych, przezroczystość na białym tle) i dopiero taki wysyła. Typowe zdjęcie waży 5–10 KB.

- najwyżej 12 obrazków na artykuł i ok. 5 na jedną stronę czytnika,
- pomijane: ikonki i flagi (poniżej 48 px), piksele śledzące, SVG,
- strony z listą artykułów (np. główna serwisu) mają małe miniatury do 80 px (ok. 2 KB) obok tytułów, najwyżej 30 na stronę
  serwisu i ok. 10 na jedną stronę czytnika,
- galerie z powiększeniem (miniatura w linku do pełnego pliku .jpg/.png/.webp) pokazują pełne obrazy zmniejszone
  dla telefonu; obrazki galerii pominięte przez czytnik trafiają do sekcji „Galeria” (do 60 na stronę),
- gdy artykuł nie ma obrazka w treści, na początku pojawia się zdjęcie główne z `og:image`,
- każde zdjęcie w artykule jest linkiem: OK otwiera w nowej karcie powiększenie do 480 px (2× ekran, JPEG jakości 65, wysokie
  obrazki np. komiksów do 2000 px – najwyżej ok. 1 mln pikseli, bezpieczne dla 64 MB RAM); z Wikipedii serwer bierze wtedy większą wersję zdjęcia (`IMAGE_HQ_WIDTH`, `IMAGE_HQ_QUALITY`),
- na dole artykułu link „Obrazki: wyłącz / włącz” (zapamiętany w ciasteczku).

Strojenie zmiennymi środowiskowymi: `IMAGE_MAX_WIDTH` (220), `IMAGE_MAX_HEIGHT` (400), `IMAGE_QUALITY` (45),
`THUMB_MAX_SIZE` (80).

## Strony, które blokują serwer

Gdy strona odmawia dostępu serwerowi Szukajki (403/401/429 albo ekran sprawdzania przeglądarki, np. Cloudflare
„Just a moment…”), czytnik pokazuje komunikat i duży przycisk „Otwórz bezpośrednio w Operze” – Opera Mini otwiera
wtedy pełną stronę przez własne serwery. Tak samo przy filmach z zablokowanego serwera.

## Filmy dla Nokii 235 4G / 3210 4G

Czytnik wykrywa filmy na każdej stronie: `<video>`, `og:video`, `twitter:player`, JSON-LD, atrybuty `data-…`, linki
do plików (.mp4, .webm, .m3u8…), adresy w konfiguracji odtwarzaczy w skryptach oraz **odtwarzacze osadzone
w ramkach** (`<iframe>`). Stronę odtwarzacza serwer otwiera i szuka w niej dalej (do 2 poziomów: ramka w ramce).
Popularne odtwarzacze z publicznym API obsługuje wprost: Vimeo, JW Player, Wistia, Kaltura. Pokazuje przycisk
„Film: obejrzyj na telefonie”, a link prosto do pliku filmu otwiera od razu stronę filmu. Serwer pobiera film
(zwykły plik albo strumień HLS – wtedy najniższą jakość, która wypełni ekran), przekodowuje go ffmpegiem i podaje
gotowy plik, który otwiera odtwarzacz telefonu:

Film przygotowuje się w ramce z miniaturą na tej samej stronie czytnika (bez przechodzenia na osobną stronę): po wybraniu
miniatury strona wraca do filmu (`#film1`), pokazuje postęp i odświeża się sama co 8 s, a gotowy film ma tam „Odtwórz”,
następną część, zapis w telefonie i przełączenie na 3GP. Z kilku źródeł w `<video>` czytnik bierze najmniejszą jakość
wypełniającą ekran i pomija DASH (`.mpd`). Strona `/film` zostaje dla linków prosto do plików filmów.

Każdy film ma miniaturę (220 px, ok. 2–4 KB) ze znakiem „odtwórz”: obrazek podany przez stronę (`poster`,
`og:image`, JSON-LD), miniaturę z API odtwarzacza (Vimeo, JW Player, Wistia, Kaltura), a gdy jej brak – klatkę z filmu
(serwer pobiera tylko początek pliku i, przez `Range`, jego koniec albo jeden odcinek strumienia HLS).

- **MP4** – H.264 Baseline (poziom 1.3), do 320×240 (pionowe do 240×320), 15 kl./s, AAC mono – ok. 2 MB na minutę,
- **3GP** – H.263 176×144, dźwięk AMR – ok. 1 MB na minutę; najbardziej zgodny ze starszymi odtwarzaczami.

Filmy są dzielone na części 3, 6 i 12 min, a dalej po 15 min: pierwsza część jest gotowa szybko (na darmowym Render
ok. 1,5 min), a każda następna przygotowuje się sama w tle, gdy oglądasz poprzednią. Film wybrany przez użytkownika
ma pierwszeństwo – przerywa przygotowywanie w tle części innego filmu. Strona postępu odświeża się sama. Pliki można pobierać ze wznawianiem
(Range), a gotowe filmy znikają po 3 godzinach. ffmpeg instaluje pip z pakietu `imageio-ffmpeg`, więc nie trzeba niczego
doinstalowywać na Render.

Nie zadziała dla YouTube, Dailymotion i Facebooka (blokują pobieranie poza swoim odtwarzaczem), filmów z DRM/szyfrowaniem,
odtwarzaczy, które pobierają adres filmu dopiero przez własne API z kluczem, i stron za zabezpieczeniem Cloudflare.
Na darmowym planie Render (słaby procesor) przygotowanie 10-minutowego filmu trwa kilka minut, a naraz
przygotowywany jest jeden film (kolejne czekają).

Strojenie: `VIDEO_FIRST_PARTS_MINUTES` (3,6,12), `VIDEO_PART_MINUTES` (15), `VIDEO_SOURCE_MAX_MB` (400), `VIDEO_CONVERT_MINUTES` (40), `VIDEO_JOBS` (1),
`VIDEO_DISK_MB` (1500), `VIDEO_DIR`.

## Szybkość

- wyniki wyszukiwania (30 min) i przeczytane strony (15 min) są zapamiętywane na dysku – wspólnie dla wszystkich
  procesów serwera, więc powtórka i powrót „Wstecz” są natychmiastowe,
- po pokazaniu wyników serwer w tle wczytuje 2 pierwsze strony (`PREFETCH_RESULTS`), więc kliknięty wynik otwiera się
  od razu; gdy klikniesz stronę, która właśnie się wczytuje, czytnik czeka na nią zamiast pobierać drugi raz,
- przed wydobyciem treści serwer usuwa skrypty, style i grafiki SVG (zwykle większość HTML), a barwy serwisu przy pierwszej
  stronie bierze z samej strony – pliki CSS doczytuje w tle (pełny wygląd od następnej strony tego serwisu),
- odpowiedź czytnika ma nagłówek `Server-Timing` (pobranie strony, wydobycie treści, wygląd) – do pomiarów,
- DuckDuckGo blokuje serwery w chmurze: po porażce aplikacja pyta od razu FrogFind, a kolejną próbę DuckDuckGo robi
  po coraz dłuższej przerwie (10 min, 20 min, 40 min… do 6 h),
- darmowy plan Render usypia aplikację po 15 min bez ruchu – pierwsze wejście trwa wtedy 30–60 s. Pomaga darmowy
  „budzik” (np. UptimeRobot albo cron-job.org) odwiedzający `https://<twoja-aplikacja>.onrender.com/healthz` co 10 min,
  albo płatny plan bez usypiania.

## Wdrożenie na Render.com

**Blueprint (najprościej):** w Render wybierz *New → Blueprint*, wskaż to repozytorium. Render odczyta `render.yaml`.

**Ręcznie (*New → Web Service*):**

- Runtime: `Python 3`
- Build Command: `pip install -r requirements.txt`
- Start Command: `gunicorn app:app --workers 2 --threads 4 --timeout 40 --bind 0.0.0.0:$PORT`
- Health Check Path: `/healthz`

## Gdy DuckDuckGo blokuje serwer

DuckDuckGo blokuje zapytania z serwerów w centrach danych – z Render.com połączenie z lite.duckduckgo.com
w ogóle nie dochodzi do skutku (sprawdzone stroną `/diag`). Wtedy wyniki przychodzą automatycznie przez
FrogFind (http://frogfind.com) – prostą nakładkę na DuckDuckGo dla starych przeglądarek, bez klucza API.
Wyniki dalej otwierają się we wbudowanym czytniku. Po pierwszej nieudanej próbie DuckDuckGo aplikacja przez
10 minut pyta od razu FrogFind, więc nie czeka na timeout.

Ograniczenia FrogFind: tylko pierwsza strona wyników (ok. 10) i region zależny od serwera FrogFind
(nie jest wymuszony polski). To darmowy serwis hobbystyczny – wyniki są przez 5 minut trzymane w pamięci,
żeby nie pytać go bez potrzeby.

Opcjonalnie: zmienna środowiskowa `BRAVE_API_KEY` (darmowy plan Brave Search API) – wtedy kolejne strony
wyników i awaria FrogFind obsługuje Brave.

## Uruchomienie lokalne

```
pip install -r requirements.txt
python app.py
```

Strona: http://localhost:5000
