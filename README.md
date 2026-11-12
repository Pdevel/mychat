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

DuckDuckGo potrafi blokować zapytania z serwerów w centrach danych (strona z captchą). Aplikacja pokazuje wtedy
komunikat „Wyszukiwarka chwilowo nie przyjmuje zapytań z tego serwera”. Rozwiązanie zapasowe: załóż darmowe konto
w Brave Search API (https://brave.com/search/api/), a klucz wpisz w Render jako zmienną środowiskową
`BRAVE_API_KEY`. Wtedy przy blokadzie DuckDuckGo wyniki przyjdą z Brave.

## Uruchomienie lokalne

```
pip install -r requirements.txt
python app.py
```

Strona: http://localhost:5000
