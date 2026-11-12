# Lekka szukajka

Wyszukiwarka i czytnik stron dla Opera Mini na telefonach z klawiaturą (Nokia 235 4G, Nokia 3210 4G).
Czysty HTML bez CSS i JavaScriptu, nawigacja samymi strzałkami.

- `/` – formularz wyszukiwania
- `/search?q=…` – wyniki z DuckDuckGo Lite (region polski), 10 na stronę, z linkiem [Oryginał]
- `/read?url=…` – czytnik: sam tekst strony (tytuł, nagłówki, akapity), podzielony na strony po ok. 3000 znaków

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
