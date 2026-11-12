# Lekka szukajka

Wyszukiwarka i czytnik stron dla Opera Mini na telefonach z klawiaturą (Nokia 235 4G, Nokia 3210 4G).
Prosty HTML bez JavaScriptu i bez plików CSS (tylko mały wbudowany `<style>`, ok. 1 KB, bez flex/grid),
nawigacja samymi strzałkami.

- `/` – formularz wyszukiwania
- `/search?q=…` – wyniki z DuckDuckGo Lite (region polski), 10 na stronę, z linkiem [Oryginał]; wpisany link
  (np. `rp.pl`, `www.onet.pl`, `https://…`) otwiera stronę od razu
- `/read?url=…` – czytnik: sam tekst strony (tytuł, nagłówki, akapity), podzielony na strony po ok. 3000 znaków
- `/read?url=…&s=słowo` – szukanie na konkretnej stronie: fragmenty z tym słowem (bez względu na wielkość liter
  i polskie znaki) z odnośnikiem do miejsca w tekście; formularz „Masz dokładny link?” na stronie głównej i na dole czytnika
- `/img?u=…` – obrazki z artykułów zmniejszone dla telefonu (szczegóły niżej)
- `/film?u=…` – filmy ze stron przekodowane dla telefonu (szczegóły niżej)

## Obrazki dla Nokii 235 4G / 3210 4G

Serwer pobiera obrazek, zmniejsza go do 220 px szerokości (ekran ma 240 px), zapisuje jako zwykły JPEG
(jakość 45, bez metadanych, przezroczystość na białym tle) i dopiero taki wysyła. Typowe zdjęcie waży 5–10 KB.

- najwyżej 12 obrazków na artykuł i ok. 5 na jedną stronę czytnika,
- pomijane: ikonki i flagi (poniżej 48 px), piksele śledzące, SVG,
- strony z listą artykułów (np. główna serwisu) mają małe miniatury do 80 px (ok. 2 KB) obok tytułów, najwyżej 30 na stronę
  serwisu i ok. 10 na jedną stronę czytnika,
- gdy artykuł nie ma obrazka w treści, na początku pojawia się zdjęcie główne z `og:image`,
- na dole artykułu link „Obrazki: wyłącz / włącz” (zapamiętany w ciasteczku).

Strojenie zmiennymi środowiskowymi: `IMAGE_MAX_WIDTH` (220), `IMAGE_MAX_HEIGHT` (400), `IMAGE_QUALITY` (45),
`THUMB_MAX_SIZE` (80).

## Filmy dla Nokii 235 4G / 3210 4G

Czytnik wykrywa filmy na każdej stronie: `<video>`, `og:video`, `twitter:player`, JSON-LD, atrybuty `data-…`, linki
do plików (.mp4, .webm, .m3u8…), adresy w konfiguracji odtwarzaczy w skryptach oraz **odtwarzacze osadzone
w ramkach** (`<iframe>`). Stronę odtwarzacza serwer otwiera i szuka w niej dalej (do 2 poziomów: ramka w ramce).
Popularne odtwarzacze z publicznym API obsługuje wprost: Vimeo, JW Player, Wistia, Kaltura. Pokazuje przycisk
„Film: obejrzyj na telefonie”, a link prosto do pliku filmu otwiera od razu stronę filmu. Serwer pobiera film
(zwykły plik albo strumień HLS – wtedy najniższą jakość, która wypełni ekran), przekodowuje go ffmpegiem i podaje
gotowy plik, który otwiera odtwarzacz telefonu:

Każdy film ma miniaturę (220 px, ok. 2–4 KB) ze znakiem „odtwórz”: obrazek podany przez stronę (`poster`,
`og:image`, JSON-LD), miniaturę z API odtwarzacza (Vimeo, JW Player, Wistia, Kaltura), a gdy jej brak – klatkę z filmu
(serwer pobiera tylko początek pliku i, przez `Range`, jego koniec albo jeden odcinek strumienia HLS).

- **MP4** – H.264 Baseline (poziom 1.3), do 320×240 (pionowe do 240×320), 15 kl./s, AAC mono – ok. 2 MB na minutę,
- **3GP** – H.263 176×144, dźwięk AMR – ok. 1 MB na minutę; najbardziej zgodny ze starszymi odtwarzaczami.

Długie filmy są dzielone na części po 15 minut. Strona postępu odświeża się sama. Pliki można pobierać ze wznawianiem
(Range), a gotowe filmy znikają po 3 godzinach. ffmpeg instaluje pip z pakietu `imageio-ffmpeg`, więc nie trzeba niczego
doinstalowywać na Render.

Nie zadziała dla YouTube, Dailymotion i Facebooka (blokują pobieranie poza swoim odtwarzaczem), filmów z DRM/szyfrowaniem,
odtwarzaczy, które pobierają adres filmu dopiero przez własne API z kluczem, i stron za zabezpieczeniem Cloudflare.
Na darmowym planie Render (słaby procesor) przygotowanie 10-minutowego filmu trwa kilka minut, a naraz
przygotowywany jest jeden film (kolejne czekają).

Strojenie: `VIDEO_PART_MINUTES` (15), `VIDEO_SOURCE_MAX_MB` (400), `VIDEO_CONVERT_MINUTES` (40), `VIDEO_JOBS` (1),
`VIDEO_DISK_MB` (1500), `VIDEO_DIR`.

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
